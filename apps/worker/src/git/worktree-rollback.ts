import { mkdirSync, readFileSync, realpathSync, rmdirSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { freshGit, git, GitError, GIT_TIMEOUT_MS, gitOk } from "./git.ts";
import {
  checkoutBlobMatches,
  directoryStillMatches,
  inspectDirectory,
  physicalDirectory,
  removeInspectedDirectory,
  sameEntry,
  samePath,
  statPath,
} from "./worktree-rollback-files.ts";

export interface NewWorktree {
  readonly path: string;
  readonly branch: string;
  readonly commit: string;
}

interface Reservation {
  readonly checkout: BigIntStats;
  readonly metadata: string;
}

type RollbackResult =
  | "removed"
  | "registration missing"
  | "registration changed"
  | "metadata ownership changed"
  | "metadata changed"
  | "index changed"
  | "checkout changed"
  | "branch changed"
  | "resources remain";

export async function registeredWorktrees(repo: string): Promise<string[][]> {
  const list = await git(repo, ["worktree", "list", "--porcelain", "-z"]);

  if (!list.ok) throw new GitError("WORKTREE_FAILED", "Git could not read the worktree list.");

  return list.stdout
    .split("\0\0")
    .filter(Boolean)
    .map((entry) => entry.split("\0"));
}

/** Git expands Windows 8.3 aliases. The filesystem can return either spelling for the same directory. */
function sameGitPath(path: string, expected: string): boolean {
  if (!isAbsolute(path)) return false;

  if (samePath(path, expected)) return true;

  if (process.platform !== "win32" || !samePath(basename(path), basename(expected))) return false;

  const parent = physicalDirectory(dirname(expected));
  const listedParent = statPath(dirname(path));

  // Compare the parent so this still works when the final component is a missing .git file.
  return Boolean(parent && parent.ino !== 0n && listedParent?.isDirectory() && sameEntry(parent, listedParent));
}

export const atPath = (entries: string[][], path: string): string[][] =>
  entries.filter(([entry]) => entry?.startsWith("worktree ") && sameGitPath(entry.slice(9), path));

export function ownsCheckout(entry: string[], tree: NewWorktree, marker: string): boolean {
  return (
    entry.includes(`locked ${marker}`) &&
    entry.includes(`branch refs/heads/${tree.branch}`) &&
    entry.includes(`HEAD ${tree.commit}`)
  );
}

const stripEol = (text: string) => text.replace(/\r?\n$/, "");

/** Record the identity of a directory we created exclusively, before Git writes a single file. */
export async function reserveCheckout(repo: string, path: string): Promise<Reservation> {
  const common = realpathSync(
    stripEol(await gitOk(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "WORKTREE_FAILED")),
  );

  const worktrees = join(common, "worktrees");
  const metadata = join(worktrees, basename(path));

  if (!physicalDirectory(dirname(path)) || (statPath(worktrees) && !physicalDirectory(worktrees)) || statPath(metadata))
    throw new GitError("WORKTREE_FAILED", "The worktree location changed during creation. Try again.");

  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    throw new GitError("WORKTREE_FAILED", "Canopy could not reserve the new worktree folder. Try again.");
  }

  const checkout = physicalDirectory(path);

  if (!checkout) throw new GitError("WORKTREE_FAILED", "The worktree location changed during creation. Try again.");

  return { checkout, metadata };
}

function smallFile(path: string): string | undefined {
  const stat = statPath(path);

  if (stat?.isFile() && stat.nlink === 1n && stat.size <= 32_768n) return stripEol(readFileSync(path, "utf8"));

  return undefined;
}

function pointsTo(from: string, value: string | undefined, to: string): boolean {
  return Boolean(value && sameGitPath(resolve(dirname(from), value), to));
}

async function checkIndex(tree: NewWorktree, metadata: string, interrupted: boolean): Promise<boolean> {
  const index = statPath(join(metadata, "index"));
  const lock = statPath(join(metadata, "index.lock"));
  const link = join(tree.path, ".git");
  const checkoutLink = statPath(link);

  if (lock && (!interrupted || index || !lock.isFile() || lock.size !== 0n)) return false;

  if (!checkoutLink) return interrupted && !index;

  if (!pointsTo(link, smallFile(link)?.match(/^gitdir: (.+)$/s)?.[1], metadata)) return false;

  if (!index) return true;

  if (!index.isFile() || index.nlink !== 1n) return false;

  const staged = await git(tree.path, [
    "diff",
    "--cached",
    "--quiet",
    "--no-ext-diff",
    "--no-textconv",
    tree.commit,
    "--",
  ]);

  return staged.ok;
}

async function trackedFiles(repo: string, commit: string): Promise<Map<string, string>> {
  const tree = await git(repo, ["ls-tree", "-r", "-t", "-z", "--full-tree", commit], GIT_TIMEOUT_MS, {
    maxBytes: 32 * 1024 * 1024,
  });

  if (!tree.ok) throw new GitError("WORKTREE_FAILED", "Git could not read the worktree base.");
  const files = new Map<string, string>();

  for (const entry of tree.stdout.split("\0")) {
    const match = /^(040000 tree|100(?:644|755) blob) ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/s.exec(entry);

    if (match?.[3] && match[2]) files.set(match[3], match[1] === "040000 tree" ? "" : match[2]);
  }

  return files;
}

function ownsMetadata(tree: NewWorktree, path: string, marker: string): boolean {
  const gitdir = join(path, "gitdir");
  const commondir = join(path, "commondir");

  return (
    Boolean(physicalDirectory(path)) &&
    smallFile(join(path, "locked")) === marker &&
    pointsTo(gitdir, smallFile(gitdir), join(tree.path, ".git")) &&
    pointsTo(commondir, smallFile(commondir), dirname(dirname(path)))
  );
}

const metadataFiles = new Set([
  "HEAD",
  "ORIG_HEAD",
  "commondir",
  "config.worktree",
  "gitdir",
  "index",
  "index.lock",
  "locked",
  "info/sparse-checkout",
  "logs/HEAD",
  "reftable/tables.list",
]);

const metadataDirs = new Set(["info", "logs", "refs", "refs/heads", "refs/tags", "reftable"]);

function isCheckoutMetadata(path: string, stat: BigIntStats, root: string): boolean {
  const key = relative(root, path).split(sep).join("/");

  if (stat.isDirectory()) return metadataDirs.has(key);

  // Split indexes and reftables use Git-generated basenames.
  return metadataFiles.has(key) || /^sharedindex\.[0-9a-f]{40,64}$|^reftable\/[0-9a-fx-]+\.ref$/.test(key);
}

async function discardCheckout(
  repo: string,
  tree: NewWorktree,
  marker: string,
  reservation: Reservation,
  interrupted: boolean,
): Promise<RollbackResult> {
  const { metadata } = reservation;
  const admin = physicalDirectory(metadata);
  const target = physicalDirectory(tree.path);
  const expires = performance.now() + GIT_TIMEOUT_MS;

  // A missing directory may have been moved away with its .git backlink intact.
  if (!target || !sameEntry(reservation.checkout, target)) return "checkout changed";

  if (!admin || !ownsMetadata(tree, metadata, marker)) return "metadata ownership changed";

  const adminPlan = await inspectDirectory(
    metadata,
    admin,
    (path, stat) => isCheckoutMetadata(path, stat, metadata),
    expires,
  );

  if (!adminPlan) return "metadata changed";

  if (!(await checkIndex(tree, metadata, interrupted))) return "index changed";
  const tracked = await trackedFiles(repo, tree.commit);
  const link = join(tree.path, ".git");

  const plan = await inspectDirectory(
    tree.path,
    target,
    (path, stat) => {
      if (samePath(path, link))
        return stat.isFile() && pointsTo(path, smallFile(path)?.match(/^gitdir: (.+)$/s)?.[1], metadata);
      const key = tracked.get(relative(tree.path, path).split(sep).join("/"));

      return stat.isDirectory() ? key === "" : key !== undefined && key !== "" && checkoutBlobMatches(path, stat, key);
    },
    expires,
  );

  if (!plan) return "checkout changed";

  if (!onlyOwnedRegistration(await registeredWorktrees(repo), tree, marker)) return "registration changed";

  if (!ownsMetadata(tree, metadata, marker)) return "metadata ownership changed";

  if (!(await ownsBranch(repo, `refs/heads/${tree.branch}`, marker))) return "branch changed";

  if (!directoryStillMatches(metadata, adminPlan)) return "metadata changed";

  return removeInspectedDirectory(tree.path, plan) && removeInspectedDirectory(metadata, adminPlan)
    ? "removed"
    : "resources remain";
}

async function ownsBranch(repo: string, ref: string, marker: string): Promise<boolean> {
  const reflog = await git(repo, ["reflog", "show", "-1", "--format=%gs", ref, "--"]);

  return reflog.ok && stripEol(reflog.stdout) === marker;
}

function onlyOwnedRegistration(entries: string[][], tree: NewWorktree, marker: string): boolean {
  const ref = `refs/heads/${tree.branch}`;
  const records = atPath(entries, tree.path);
  const [record] = records;

  return (
    records.length === 1 &&
    record !== undefined &&
    ownsCheckout(record, tree, marker) &&
    entries.filter((entry) => entry.includes(`branch ${ref}`)).length === 1
  );
}

/** Roll back only resources of this attempt, after the checkout and its process tree stopped. */
export const rollbackWorktree = (
  repo: string,
  tree: NewWorktree,
  marker: string,
  reservation: Reservation | undefined,
  interrupted: boolean,
): Promise<RollbackResult> =>
  freshGit(async () => {
    const ref = `refs/heads/${tree.branch}`;
    const entries = await registeredWorktrees(repo);

    if (atPath(entries, tree.path).length) {
      if (!reservation || !onlyOwnedRegistration(entries, tree, marker)) return "registration changed";

      if (!(await ownsBranch(repo, ref, marker))) return "branch changed";
      const discarded = await discardCheckout(repo, tree, marker, reservation, interrupted);

      if (discarded !== "removed") return discarded;
    } else {
      if (reservation && statPath(reservation.metadata)) return "registration missing";
      const target = physicalDirectory(tree.path);

      if (target && reservation && sameEntry(reservation.checkout, target)) {
        // Git may fail before creating a registration. rmdir only removes our empty reservation.
        rmdirSync(tree.path);
      }
    }

    const current = await git(repo, ["show-ref", "--verify", "--quiet", ref]);
    const remains = Boolean(statPath(tree.path));

    if (!current.ok) return current.stderr === "" && !remains ? "removed" : "resources remain";

    if (
      !(await ownsBranch(repo, ref, marker)) ||
      (await registeredWorktrees(repo)).some((record) => record.includes(`branch ${ref}`))
    )
      return "branch changed";
    const deleted = await git(repo, ["update-ref", "--no-deref", "-d", ref, tree.commit]);

    return deleted.ok && !remains ? "removed" : "resources remain";
  });
