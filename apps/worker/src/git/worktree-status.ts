import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { WorktreeStatusSchema, type WorktreeTarget } from "@canopy/contracts";
import { FETCH_TIMEOUT_MS, git, GitError, gitOk } from "./git.ts";
import { isWithin } from "./worktrees.ts";
import { githubRepository, mergedInto } from "./merged.ts";

/**
 * Verify both the root boundary and git's registration, including which checkout is the main one. Without a
 * configured location, any managed root counts (the home folder and the legacy `<data_dir>/worktrees`).
 */
export async function checkedWorktree(managedRoots: readonly string[], target: WorktreeTarget) {
  const roots = target.location ? [realpathSync(target.location)] : managedRoots;
  const repo = realpathSync(target.repoRoot);
  const path = existsSync(target.path) ? realpathSync(target.path) : resolve(target.path);

  if (!isAbsolute(target.path) || !roots.some((root) => path !== root && isWithin(root, path)))
    throw new GitError("PATH_OUTSIDE_ROOT", "the worktree is outside its creation root");
  const listed = await gitOk(repo, ["worktree", "list", "--porcelain", "-z"], "WORKTREE_NOT_FOUND");

  const records = listed
    .split("\0\0")
    .filter(Boolean)
    .map((record) => record.split("\0"));

  const first = records[0]?.find((line) => line.startsWith("worktree "))?.slice(9);

  if (!first || realpathSync(first) === path || repo === path)
    throw new GitError("MAIN_CHECKOUT", "the main checkout cannot be removed");
  const record = records.find((lines) => lines.some((line) => line === `worktree ${path}`));

  if (!record || !existsSync(path)) throw new GitError("WORKTREE_NOT_FOUND", "the registered worktree is missing");

  // An empty branch is a detached HEAD, as the worker last reported it (GitHeads).
  const head = target.branch ? `branch refs/heads/${target.branch}` : "detached";

  if (!record.includes(head) || record.some((line) => line.startsWith("locked")))
    throw new GitError("WORKTREE_CHANGED", "the worktree branch changed or the worktree is locked");

  const actual = realpathSync((await gitOk(path, ["rev-parse", "--show-toplevel"], "NOT_A_REPOSITORY")).trim());

  const common = async (cwd: string) =>
    realpathSync(
      (await gitOk(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "NOT_A_REPOSITORY")).trim(),
    );

  if (actual !== path || (await common(path)) !== (await common(repo)))
    throw new GitError("WORKTREE_CHANGED", "the worktree belongs to another repository");

  return { path, repo };
}

/** A fetch failure is a blocking result: automatic removal must not rely on stale remote refs. */
export async function scanWorktree(managedRoots: readonly string[], target: WorktreeTarget, fetch: boolean) {
  const { path, repo } = await checkedWorktree(managedRoots, target);
  const remote = target.remote || "origin";
  const remotes = (await gitOk(repo, ["remote"], "GIT_FAILED")).trim().split("\n").filter(Boolean);

  if (fetch && remotes.length) {
    if (!remotes.includes(remote)) throw new GitError("REMOTE_MISSING", "the configured remote does not exist");
    await gitOk(repo, ["fetch", "--prune", "--no-tags", "--", remote], "FETCH_FAILED", FETCH_TIMEOUT_MS);
  }

  const head = (await gitOk(path, ["rev-parse", "HEAD"], "GIT_FAILED")).trim();

  // --no-renames makes every NUL record one file, including untracked files.
  const dirty = (
    await gitOk(
      path,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--no-renames"],
      "GIT_FAILED",
    )
  )
    .split("\0")
    .filter(Boolean);

  const upstream = await git(path, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  let ahead = 0;
  let behind = 0;

  const comparison = await git(path, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${upstream.ok ? "@{upstream}" : target.baseRef}^{commit}`,
  ]);

  if (comparison.ok) {
    const counts = (
      await gitOk(path, ["rev-list", "--left-right", "--count", `HEAD...${comparison.stdout.trim()}`], "GIT_FAILED")
    )
      .trim()
      .split(/\s+/);

    ahead = Number(counts[0]);
    behind = Number(counts[1]);
  }

  const unique = remotes.length
    ? Number((await gitOk(path, ["rev-list", "--count", "HEAD", "--not", "--remotes"], "GIT_FAILED")).trim())
    : head === target.baseCommit
      ? 0
      : 1;

  const defaultRef = await git(repo, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  let defaultBranch = defaultRef.ok ? defaultRef.stdout.trim() : "";

  if (!defaultBranch) {
    for (const name of ["main", "master"]) {
      const ref = remotes.includes(remote) ? `refs/remotes/${remote}/${name}` : `refs/heads/${name}`;

      if ((await git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref])).ok) {
        defaultBranch = ref;
        break;
      }
    }
  }

  const base = target.baseRef.startsWith(`${remote}/`) ? target.baseRef : `refs/remotes/${remote}/${target.baseRef}`;
  const remoteUrl = await git(repo, ["config", "--get", `remote.${remote}.url`]);
  const repository = remoteUrl.ok ? githubRepository(remoteUrl.stdout.trim()) : "";

  const merged =
    (repository !== "" && target.mergedPrRepository === repository && target.mergedPrHead === head) ||
    (await mergedInto(repo, defaultBranch, head)) ||
    (await mergedInto(repo, remotes.includes(remote) ? base : target.baseRef, head));

  let activity = statSync(path).mtimeMs;

  for (const file of dirty.map((line) => resolve(path, line.slice(3)))) {
    if (isWithin(path, file) && existsSync(file)) activity = Math.max(activity, statSync(file).mtimeMs);
  }

  for (const name of ["index", "logs/HEAD"]) {
    const file = (await gitOk(path, ["rev-parse", "--path-format=absolute", "--git-path", name], "GIT_FAILED")).trim();

    if (existsSync(file)) activity = Math.max(activity, statSync(file).mtimeMs);
  }

  return create(WorktreeStatusSchema, {
    id: target.id,
    branch: target.branch,
    ahead,
    behind,
    dirtyFiles: dirty.length,
    unpushed: !merged && (unique > 0 || (upstream.ok && ahead > 0)),
    merged,
    unchanged: head === target.baseCommit && dirty.length === 0,
    headCommit: head,
    githubRepository: repository,
    lastActivityAt: timestampFromDate(new Date(activity)),
  });
}
