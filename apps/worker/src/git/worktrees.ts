import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { CreateWorktree, RenameWorktreeBranch, WorktreeInfoSchema } from "@canopy/contracts";
import { FETCH_TIMEOUT_MS, git, GitError, gitMessage, gitOk, validBranch } from "./git.ts";
import { listGitRefs, repoRoot } from "./refs.ts";

export type WorktreeInfoInit = MessageInitShape<typeof WorktreeInfoSchema>;

/** Attempts at a free branch name or folder (`name-2`, `name-3`, ...). */
const MAX_SUFFIX = 50;

/** `<data_dir>/worktrees` as a real path: where new worktrees go without a configured location. */
export function managedWorktreesRoot(dataDir: string): string {
  const root = join(dataDir, "worktrees");
  mkdirSync(root, { recursive: true, mode: 0o700 });

  return realpathSync(root);
}

/** `path` is `root` or below it (both real paths). */
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);

  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Where new worktrees go: the configured absolute folder (created when missing), else the managed root. Both are
 * real paths, so a symlink cannot move a worktree out of them.
 */
export function worktreeRoot(managedRoot: string, location: string): string {
  if (location && !isAbsolute(location))
    throw new GitError("LOCATION_NOT_ABSOLUTE", `the worktree location ${location} must be an absolute path`);
  const root = location || managedRoot;

  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });

    return realpathSync(root);
  } catch {
    throw new GitError("LOCATION_UNAVAILABLE", `the worktree location ${root} cannot be created`);
  }
}

/** A folder name from a branch or repository name: no separators, dots at the start or control characters. */
export function folderName(name: string): string {
  const safe = name
    .replace(/[/\\]+/g, "-")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 80);

  return safe || "worktree";
}

async function commitOf(cwd: string, ref: string): Promise<string | undefined> {
  const result = await git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);

  return result.ok ? result.stdout.trim() : undefined;
}

async function freeBranch(cwd: string, wanted: string): Promise<string> {
  if (!(await validBranch(cwd, wanted))) throw new GitError("BAD_BRANCH", `${wanted} is not a valid branch name`);

  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const name = n === 1 ? wanted : `${wanted}-${n}`;

    if (!(await commitOf(cwd, `refs/heads/${name}`))) return name;
  }

  throw new GitError("BRANCH_EXISTS", `${wanted} and its numbered variants already exist`);
}

function freeFolder(parent: string, wanted: string): string {
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const path = join(parent, n === 1 ? wanted : `${wanted}-${n}`);

    if (!existsSync(path) && !lstatSync(path, { throwIfNoEntry: false })) return path;
  }

  throw new GitError("PATH_EXISTS", `${join(parent, wanted)} and its numbered variants already exist`);
}

/**
 * The remote branch a worktree starts from with "Start from remote": the base's tracked branch, else the
 * same-named branch on `remote`; fetched first. Undefined (start from the local ref) when there is none or the
 * fetch fails.
 */
async function remoteStart(root: string, base: string, remote: string): Promise<string | undefined> {
  const remotes = (await git(root, ["remote"])).stdout.split("\n").filter(Boolean);
  const tracked = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${base}@{upstream}`]);
  const upstream = tracked.ok ? tracked.stdout.trim() : "";
  const remoteRef = remotes.some((r) => base.startsWith(`${r}/`)) ? base : "";
  const candidate = upstream || remoteRef || (remotes.includes(remote) ? `${remote}/${base}` : "");
  const owner = remotes.find((r) => candidate.startsWith(`${r}/`));

  if (!candidate || !owner) return undefined;
  const branch = candidate.slice(owner.length + 1);
  const fetched = await git(root, ["fetch", "--no-tags", "--", owner, branch], FETCH_TIMEOUT_MS).catch(() => undefined);

  if (!fetched?.ok) return undefined;

  return (await commitOf(root, `refs/remotes/${candidate}`)) ? candidate : undefined;
}

/** A new branch in a new worktree under the root, from the base (or its remote branch). */
export async function createWorktree(managedRoot: string, request: CreateWorktree): Promise<WorktreeInfoInit> {
  const repo = await repoRoot(request.repoPath);

  if (!repo) throw new GitError("NOT_A_REPOSITORY", `${request.repoPath} is not in a git repository`);
  const root = worktreeRoot(managedRoot, request.location);
  const base = request.baseRef || (await listGitRefs(repo, request.remote || "origin")).defaultBranch || "HEAD";

  if (base.startsWith("-") || !(await commitOf(repo, base)))
    throw new GitError("BAD_REF", `${base} is not a branch or commit of this repository`);
  const start = (request.startFromRemote && (await remoteStart(repo, base, request.remote || "origin"))) || base;
  const commit = (await commitOf(repo, start)) ?? "";
  const branch = await freeBranch(repo, request.branch);
  const parent = join(root, folderName(basename(repo)));
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  if (!isWithin(root, realpathSync(parent)))
    throw new GitError("PATH_OUTSIDE_ROOT", "the worktree repository folder is outside its root");
  const path = freeFolder(parent, folderName(branch));

  if (!isWithin(root, path)) throw new GitError("PATH_OUTSIDE_ROOT", "the worktree path is outside its root");
  // The commit (not the ref name) is the start point: nothing from the request reaches git as an option.
  await gitOk(repo, ["worktree", "add", "--no-track", "-b", branch, "--", path, commit], "WORKTREE_FAILED");

  if (!isWithin(root, realpathSync(path)))
    throw new GitError("PATH_OUTSIDE_ROOT", "the worktree path is outside its root");

  // Preserve the configured root's spelling (it may itself be a symlink); containment uses its real path above.
  const visiblePath = request.location ? join(request.location, relative(root, path)) : path;

  return { path: visiblePath, branch, repoRoot: repo, baseRef: start, baseCommit: commit };
}

/** Renames the branch of a worktree under a root, while it is still checked out there and has no upstream. */
export async function renameWorktreeBranch(
  managedRoot: string,
  request: RenameWorktreeBranch,
): Promise<WorktreeInfoInit> {
  let path: string;

  try {
    path = realpathSync(request.path);
  } catch {
    throw new GitError("WORKTREE_NOT_FOUND", `${request.path} does not exist`);
  }

  const roots = [managedRoot, ...(request.location ? [request.location] : [])].flatMap((r) =>
    existsSync(r) ? [realpathSync(r)] : [],
  );

  if (!roots.some((root) => isWithin(root, path) && root !== path))
    throw new GitError("PATH_OUTSIDE_ROOT", `${request.path} is not under a worktree root`);

  if ((await repoRoot(path)) !== path) throw new GitError("WORKTREE_NOT_FOUND", `${path} is not a worktree`);

  const unchanged = (detail: string): WorktreeInfoInit => ({
    path,
    branch: request.fromBranch,
    renamed: false,
    detail,
  });

  const current = await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

  if (!current.ok || current.stdout.trim() !== request.fromBranch)
    return unchanged("the worktree is on another branch");

  if (!(await validBranch(path, request.fromBranch))) throw new GitError("BAD_BRANCH", "invalid source branch");

  if ((await git(path, ["rev-parse", "--abbrev-ref", `${request.fromBranch}@{upstream}`])).ok)
    return unchanged("the branch already has an upstream");
  const branch = await freeBranch(path, request.toBranch);
  const moved = await git(path, ["branch", "-m", "--", request.fromBranch, branch]);

  if (!moved.ok) return unchanged(gitMessage(moved.stderr));

  return { path, branch, renamed: true };
}
