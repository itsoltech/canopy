import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readlink, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { copyGenerated, copyLocalConfig, copySafePath, copySecret } from "@canopy/domain/workspace-copy";
import { git, type GitResult } from "../git/git.ts";
import { withoutGitHooks } from "../git/read-policy.ts";
import { transferError } from "./errors.ts";

/**
 * The working tree side of a thread transfer (docs/thread-transfers.md). The thread's checkout is described by its
 * HEAD, the index and working tree changes against it, untracked files and local files the owner chose; the target
 * recreates exactly that in a new worktree of its own repository and checks the result file by file.
 */

/** Ignored local files offered to take along stay small: configuration, not data. */
export const LOCAL_FILE_BYTES = 1024 ** 2;

export interface CheckoutSummary {
  blocked: string;
  head: string;
  branch: string;
  changedFiles: number;
  untrackedFiles: number;
  unpushedCommits: number;
  localFiles: { path: string; size: bigint; secret: boolean }[];
}

/** A changed path and the SHA-256 of its content after the move ("" = deleted, "link:<sha>" = a symlink). */
export interface TreeEntry {
  path: string;
  sha256: string;
}

const lines = (result: GitResult) => result.stdout.split("\0").filter(Boolean);

/** Git without hooks, fsmonitor or external diff: a transfer never runs the repository's code. */
const plainGit = (cwd: string, args: readonly string[], input?: { text?: string }) =>
  git(cwd, [...withoutGitHooks, "-c", "core.fsmonitor=", ...args], 120_000, input);

/** The thread's directory must be the top of a Git checkout with at least one commit. */
async function checkoutRoot(cwd: string): Promise<{ root: string; head: string } | { blocked: string }> {
  let root: string;

  try {
    root = await realpath(cwd);
  } catch {
    return { blocked: "The thread's folder is missing on this worker." };
  }

  const top = await git(root, ["rev-parse", "--show-toplevel"]);

  if (!top.ok) return { blocked: "Only threads in a Git repository can move with their files." };

  if ((await realpath(top.stdout.trim()).catch(() => "")) !== root)
    return { blocked: "The thread's folder is not the top of its Git checkout." };
  const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);

  if (!head.ok) return { blocked: "Make a first commit in this repository before moving the thread." };

  if ((await lstat(join(root, ".gitmodules")).catch(() => undefined))?.isFile())
    return { blocked: "Repositories with submodules can't move with their files yet." };
  // Effective attributes of tracked files: an LFS file would otherwise arrive as its pointer.
  const lfs = await git(root, ["ls-files", "-z", "--", ":(attr:filter=lfs)"]);

  if (!lfs.ok || lfs.stdout) return { blocked: "Repositories that use Git LFS can't move with their files yet." };

  return { root, head: head.stdout.trim() };
}

export async function inspectCheckout(cwd: string): Promise<CheckoutSummary> {
  const empty = { head: "", branch: "", changedFiles: 0, untrackedFiles: 0, unpushedCommits: 0, localFiles: [] };
  const checked = await checkoutRoot(cwd);

  if ("blocked" in checked) return { ...empty, blocked: checked.blocked };
  const { root, head } = checked;
  const branch = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);

  if (!status.ok) return { blocked: "Git could not read the thread's changes.", ...empty };
  let changedFiles = 0;
  let untrackedFiles = 0;
  const entries = lines(status);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    if (entry.startsWith("??")) untrackedFiles++;
    else changedFiles++;

    // A rename or copy is followed by its original path.
    if (/^[RC]/.test(entry)) i++;
  }

  const unpushed = await git(root, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);

  return {
    blocked: "",
    head,
    branch: branch.ok ? branch.stdout.trim() : "",
    changedFiles,
    untrackedFiles,
    unpushedCommits: unpushed.ok ? Number(unpushed.stdout.trim()) || 0 : 0,
    localFiles: await localFiles(root),
  };
}

/**
 * Files the owner chooses to take along: ignored local configuration (for example `.env`) next to the code, and new
 * files that may hold secrets (they never move unchosen). Dependencies and build output never.
 */
async function localFiles(root: string): Promise<CheckoutSummary["localFiles"]> {
  const ignored = await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
  const found = await untrackedSecrets(root);

  if (!ignored.ok) return found;

  for (const path of lines(ignored)) {
    if (path.endsWith("/") || !copySafePath(path) || copyGenerated(dirname(path))) continue;

    if (!copyLocalConfig(path) && !copySecret(path)) continue;
    const info = await lstat(join(root, path)).catch(() => undefined);

    if (info?.isFile() && info.size <= LOCAL_FILE_BYTES)
      found.push({ path, size: BigInt(info.size), secret: copySecret(path) });

    if (found.length >= 200) break;
  }

  return found;
}

/** New, not ignored files that may hold secrets: chosen and confirmed like ignored ones, at any size. */
async function untrackedSecrets(root: string): Promise<CheckoutSummary["localFiles"]> {
  const untracked = await git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
  const found: CheckoutSummary["localFiles"] = [];

  for (const path of untracked.ok ? lines(untracked) : []) {
    if (!copySafePath(path) || !copySecret(path)) continue;
    const info = await lstat(join(root, path)).catch(() => undefined);

    if (info?.isFile()) found.push({ path, size: BigInt(info.size), secret: true });

    if (found.length >= 100) break;
  }

  return found;
}

export interface CheckoutExport {
  head: string;
  branch: string;
  bundle: boolean;
  indexPatch: boolean;
  worktreePatch: boolean;
  /** Files written into the new checkout as they are: untracked files and chosen local files. */
  files: string[];
  /** Their permission bits (executable scripts stay executable). */
  modes: Record<string, number>;
  tree: TreeEntry[];
  /** The chosen local files, and the checkout's state when it was exported (checked again before the commit). */
  localFiles: string[];
  fingerprint: string;
}

/**
 * Writes the checkout's state into `pkg` (`git/…`, `files/…`) and returns its description. The checkout must still be
 * at `expectedHead`, the commit the owner saw in the preview.
 */
export async function exportCheckout(
  cwd: string,
  pkg: string,
  request: { expectedHead: string; knownCommits: readonly string[]; localFiles: readonly string[] },
  copyIn: (root: string, path: string, destination: string) => Promise<void>,
): Promise<CheckoutExport> {
  const checked = await checkoutRoot(cwd);

  if ("blocked" in checked) throw transferError(checked.blocked);
  const { root, head } = checked;

  if (request.expectedHead && head !== request.expectedHead)
    throw transferError("The thread's checkout moved to another commit. Review the move again.");
  const before = await checkoutFingerprint(root, request.localFiles);
  const branch = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const bundle = await writeBundle(root, join(pkg, "git", "head.bundle"), request.knownCommits);
  const indexPatch = await writeDiff(root, join(pkg, "git", "index.patch"), ["--cached"]);
  const worktreePatch = await writeDiff(root, join(pkg, "git", "worktree.patch"), []);
  const untracked = await git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);

  if (!untracked.ok) throw transferError("Git could not list the thread's new files.");
  const allowed = new Set((await localFiles(root)).map((f) => f.path));

  if (request.localFiles.some((path) => !allowed.has(path)))
    throw transferError("A chosen local file is no longer available. Review the move again.");
  const files: string[] = [];
  const modes: Record<string, number> = {};

  // A new file that may hold secrets moves only when chosen (and the owner confirmed it).
  const chosen = new Set(request.localFiles);

  for (const path of new Set([...lines(untracked).filter((p) => !copySecret(p) || chosen.has(p)), ...chosen])) {
    if (!copySafePath(path)) throw transferError("A new file has a name that cannot be moved.");
    const info = await lstat(join(root, path)).catch(() => undefined);

    // New links and special files stay; the target never recreates a link from another computer.
    if (!info?.isFile()) continue;
    await copyIn(root, path, join(pkg, "files", path));
    files.push(path);
    modes[path] = info.mode & 0o777;
  }

  const changed = await git(root, ["diff", "--name-only", "-z", "HEAD"]);

  if (!changed.ok) throw transferError("Git could not list the thread's changes.");
  const paths = [...new Set([...lines(changed), ...files])].sort();
  const tree = await treeOf(root, paths);
  const fingerprint = await checkoutFingerprint(root, request.localFiles);

  if (fingerprint !== before) throw transferError("The thread's files changed while moving. Try again.");

  return {
    head,
    branch: branch.ok ? branch.stdout.trim() : "",
    bundle,
    indexPatch,
    worktreePatch,
    files,
    modes,
    tree,
    localFiles: [...request.localFiles],
    fingerprint,
  };
}

/**
 * The checkout's state as one hash: HEAD, the index, every changed or new path and the content of each, and the
 * chosen local files. Equal before and after the export, and again before the commit.
 */
export async function checkoutFingerprint(root: string, localFiles: readonly string[]): Promise<string> {
  const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  const index = await git(root, ["diff", "--cached", "--raw", "--full-index", "--no-renames", "-z"]);
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);

  if (!head.ok || !index.ok || !status.ok) throw transferError("Git could not read the thread's changes.");
  const hash = createHash("sha256").update(`${head.stdout}\0${index.stdout}\0${status.stdout}`);
  const paths = [...new Set([...lines(status).map((entry) => entry.slice(3)), ...localFiles])].sort();

  for (const entry of await treeOf(root, paths)) hash.update(`\0${entry.path}\0${entry.sha256}`);

  return hash.digest("hex");
}

/** The source checkout still is what was exported. */
export async function verifyCheckout(cwd: string, exported: { localFiles: string[]; fingerprint: string }) {
  const checked = await checkoutRoot(cwd);

  if ("blocked" in checked || (await checkoutFingerprint(checked.root, exported.localFiles)) !== exported.fingerprint)
    throw transferError("The thread's files changed while moving. Nothing was moved; try again.");
}

/** The commits on HEAD the target lacks; nothing when it already has them all. */
async function writeBundle(root: string, file: string, known: readonly string[]): Promise<boolean> {
  const valid = known.filter((sha) => /^[0-9a-f]{40,64}$/.test(sha)).slice(0, 2000);
  let present: string[] = [];

  if (valid.length) {
    const check = await plainGit(root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
      text: `${valid.join("\n")}\n`,
    });

    present = check.stdout
      .split("\n")
      .map((line) => line.split(" "))
      .flatMap(([sha, type]) => (type === "commit" && sha ? [sha] : []));
  }

  const revisions = ["HEAD", ...present.map((sha) => `^${sha}`)].join("\n");
  const count = await plainGit(root, ["rev-list", "--count", "--stdin"], { text: `${revisions}\n` });

  if (!count.ok) throw transferError("Git could not count the thread's commits.");

  if (Number(count.stdout.trim()) === 0) return false;
  await mkdirFor(file);
  const created = await plainGit(root, ["bundle", "create", "--quiet", file, "--stdin"], { text: `${revisions}\n` });

  if (!created.ok) throw transferError("Git could not package the thread's commits.");

  return true;
}

async function writeDiff(root: string, file: string, options: readonly string[]): Promise<boolean> {
  await mkdirFor(file);
  const result = await git(root, ["diff", ...options, "--binary", "--full-index", "--no-renames", `--output=${file}`]);

  if (!result.ok) throw transferError("Git could not record the thread's changes.");

  return ((await lstat(file).catch(() => undefined))?.size ?? 0) > 0;
}

async function mkdirFor(file: string) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
}

/**
 * `path` below `root`: portable, and every ancestor that exists is a real directory (never a link). Reading or
 * creating anything for a moved path starts here.
 */
export async function plainPath(root: string, path: string, create = false): Promise<string> {
  if (!copySafePath(path)) throw transferError("The transfer names a path that cannot be moved.");
  let current = root;

  for (const part of path.split("/").slice(0, -1)) {
    current = join(current, part);
    let info = await lstat(current).catch(() => undefined);

    if (!info && !create) break;

    if (!info) {
      await mkdir(current, { mode: 0o755 }).catch(() => undefined);
      info = await lstat(current).catch(() => undefined);
    }

    if (!info?.isDirectory() || info.isSymbolicLink())
      throw transferError("A moved path runs through a link or a file in the checkout.");
  }

  return join(root, ...path.split("/"));
}

/** The content each changed path must have after the move. */
export async function treeOf(root: string, paths: readonly string[]): Promise<TreeEntry[]> {
  const tree: TreeEntry[] = [];

  for (const path of paths) {
    const full = await plainPath(root, path);
    const info = await lstat(full).catch(() => undefined);

    const sha256 = !info
      ? ""
      : info.isSymbolicLink()
        ? `link:${createHash("sha256")
            .update(await readlink(full))
            .digest("hex")}`
        : info.isFile()
          ? await fileSha256(full)
          : "other";

    tree.push({ path, sha256 });
  }

  return tree;
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(path)) hash.update(chunk);

  return hash.digest("hex");
}

/** Commits the target repository already has: tips of branches, remote-tracking refs and tags. */
export async function repositoryTips(repo: string): Promise<string[]> {
  const refs = await git(repo, ["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes", "refs/tags"]);

  if (!refs.ok) throw transferError("The target workspace is not a Git repository.");

  return [...new Set(refs.stdout.split("\n").filter(Boolean))].slice(0, 2000);
}

export const transferRef = (token: string) => `refs/canopy/transfers/${token}`;

/** Fetches the package's commits into the target repository; the head must then be there. */
export async function fetchCommits(repo: string, stage: string, token: string, head: string, bundle: boolean) {
  if (bundle) {
    const file = join(stage, "git", "head.bundle");
    const verified = await plainGit(repo, ["bundle", "verify", "--quiet", file]);

    if (!verified.ok)
      throw transferError(
        "The target repository lacks commits the thread builds on. Fetch the repository there first.",
      );

    const fetched = await plainGit(repo, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      file,
      `HEAD:${transferRef(token)}`,
    ]);

    if (!fetched.ok) throw transferError("Git could not take the thread's commits on the target.");
  }

  const present = await git(repo, ["rev-parse", "--verify", "-q", `${head}^{commit}`]);

  if (!present.ok || present.stdout.trim() !== head)
    throw transferError("The target repository lacks the thread's commit. Fetch the repository there first.");
}

/** Fails when Git can't delete the ref (a lock, an error): the cleanup is then tried again. */
export async function dropTransferRef(repo: string, token: string) {
  if (!repo) return;
  const dropped = await plainGit(repo, ["update-ref", "-d", transferRef(token)]);

  if (!dropped.ok) throw transferError("Git could not remove the move's commits from the target. Try again.");
}

/**
 * Recreates the changes in `cwd`, a fresh checkout of `head`, and checks every changed path. Writes only inside cwd.
 * `place` writes a package file to its destination without following links and refuses an existing file.
 */
export async function applyCheckout(
  cwd: string,
  stage: string,
  description: CheckoutExport,
  place: (from: string, root: string, path: string, mode: number) => Promise<void>,
) {
  const root = await realpath(cwd);
  const paths = [...description.tree.map((e) => e.path), ...description.files, ...Object.keys(description.modes)];

  // Every path of the description is checked before anything is read or written.
  if (paths.some((path) => !copySafePath(path))) throw transferError("The transfer names a path that cannot be moved.");
  const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);

  if (!head.ok || head.stdout.trim() !== description.head || !status.ok || status.stdout)
    throw transferError("The new checkout is not at the thread's commit.");

  if (description.indexPatch) await applyPatch(root, join(stage, "git", "index.patch"), ["--index"]);

  if (description.worktreePatch) await applyPatch(root, join(stage, "git", "worktree.patch"), []);

  for (const path of description.files)
    await place(join(stage, "files", path), root, path, description.modes[path] ?? 0o644);

  const after = await treeOf(
    root,
    description.tree.map((entry) => entry.path),
  );

  if (after.some((entry, i) => entry.sha256 !== description.tree[i]!.sha256))
    throw transferError("The moved files differ from the thread's files. Nothing was moved.");
}

async function applyPatch(root: string, patch: string, options: readonly string[]) {
  const applied = await plainGit(root, ["apply", ...options, "--binary", "--whitespace=nowarn", patch]);

  if (!applied.ok) throw transferError("Git could not apply the thread's changes on the target.");
}
