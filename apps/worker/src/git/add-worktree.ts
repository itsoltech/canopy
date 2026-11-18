import { lstatSync, realpathSync } from "node:fs";
import { dirname, relative } from "node:path";
import { git, GitError } from "./git.ts";

/** Keep room for metadata, an optional fetch and rollback in the gateway's wait. */
const WORKTREE_ADD_TIMEOUT_MS = 60_000;

interface NewWorktree {
  readonly path: string;
  readonly branch: string;
  readonly commit: string;
}

const samePath = (from: string, to: string) => relative(from, to) === "";

async function registeredWorktrees(repo: string): Promise<string[][]> {
  const list = await git(repo, ["worktree", "list", "--porcelain", "-z"]);

  if (!list.ok) throw new GitError("WORKTREE_FAILED", "Git could not read the worktree list.");

  return list.stdout
    .split("\0\0")
    .filter(Boolean)
    .map((entry) => entry.split("\0"));
}

function atPath(entries: string[][], path: string): string[] | undefined {
  return entries.find(([entry]) => entry?.startsWith("worktree ") && samePath(path, entry.slice(9)));
}

function ownsCheckout(entry: string[], tree: NewWorktree, marker: string): boolean {
  if (!entry.includes(`locked ${marker}`) || !entry.includes(`branch refs/heads/${tree.branch}`)) return false;

  if (!entry.includes(`HEAD ${tree.commit}`) || !samePath(dirname(tree.path), realpathSync(dirname(tree.path))))
    return false;
  const target = lstatSync(tree.path, { throwIfNoEntry: false });

  return !target || (target.isDirectory() && samePath(tree.path, realpathSync(tree.path)));
}

/** Only undo the registration and ref that carry this attempt's marks. */
async function rollback(repo: string, tree: NewWorktree, marker: string): Promise<boolean> {
  const ref = `refs/heads/${tree.branch}`;
  const entries = await registeredWorktrees(repo);
  const entry = atPath(entries, tree.path);
  let incomplete = Boolean(lstatSync(tree.path, { throwIfNoEntry: false }));

  if (entry && ownsCheckout(entry, tree, marker)) {
    const removed = await git(repo, ["worktree", "remove", "--force", "--force", "--", tree.path]);
    incomplete = !removed.ok;
  } else if (entry) {
    incomplete = true;
  }

  const current = await git(repo, ["show-ref", "--verify", "--quiet", ref]);

  if (!current.ok) return current.stderr === "" && !incomplete;
  const reflog = await git(repo, ["reflog", "show", "-1", "--format=%gs", ref, "--"]);

  if (
    !reflog.ok ||
    reflog.stdout.trim() !== marker ||
    (await registeredWorktrees(repo)).some((record) => record.includes(`branch ${ref}`))
  )
    return false;
  const deleted = await git(repo, ["update-ref", "--no-deref", "-d", ref, tree.commit]);

  return deleted.ok && !incomplete;
}

export const WORKTREE_CLEANUP_WARNING =
  "Canopy could not finish cleanup. Check the worktree and branch before retrying.";

/** Use Git for checkout and hooks. Reflog intent and an attempt-specific lock make rollback verifiable. */
export async function addWorktree(repo: string, tree: NewWorktree, timeoutMs = WORKTREE_ADD_TIMEOUT_MS): Promise<void> {
  const marker = `Canopy worktree creation ${crypto.randomUUID()}`;
  const ref = `refs/heads/${tree.branch}`;
  let branchRejected = false;

  try {
    // The empty expected value makes this atomic, even if another client just took the branch name.
    const branch = await git(repo, ["update-ref", "--no-deref", "--create-reflog", "-m", marker, ref, tree.commit, ""]);
    branchRejected = !branch.ok;

    if (branchRejected)
      throw new GitError("WORKTREE_FAILED", "Git could not create the worktree branch. Retry with a different name.");

    const checkout = await git(
      repo,
      ["worktree", "add", "--quiet", "--lock", "--reason", marker, "--no-guess-remote", "--", tree.path, tree.branch],
      timeoutMs,
    );

    if (!checkout.ok)
      throw new GitError(
        "WORKTREE_CHECKOUT_FAILED",
        "Git could not check out the worktree. Check the Git settings and filters.",
      );
    const entry = atPath(await registeredWorktrees(repo), tree.path);

    if (!entry || !ownsCheckout(entry, tree, marker))
      throw new GitError(
        "WORKTREE_FAILED",
        "The worktree changed during creation. Check the worktree before retrying.",
      );
    const unlocked = await git(repo, ["worktree", "unlock", "--", tree.path]);

    if (!unlocked.ok)
      throw new GitError(
        "WORKTREE_FAILED",
        "Git could not unlock the new worktree. Check the worktree before retrying.",
      );
  } catch (error) {
    if (branchRejected || (await rollback(repo, tree, marker).catch(() => false))) throw error;

    const cause =
      error instanceof GitError ? error : new GitError("WORKTREE_FAILED", "Git could not create the worktree.");

    throw new GitError(cause.code, `${cause.message} ${WORKTREE_CLEANUP_WARNING}`);
  }
}
