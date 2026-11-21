import { ProcessTimeoutError } from "@canopy/process-governor";
import { git, GitError, settleWorktreeGit } from "./git.ts";
import {
  atPath,
  ownsCheckout,
  registeredWorktrees,
  reserveCheckout,
  rollbackWorktree,
  type NewWorktree,
} from "./worktree-rollback.ts";
import { physicalDirectory, sameEntry } from "./worktree-rollback-files.ts";

/** Used by gateways that still wait only 90 seconds for the entire command. */
const LEGACY_WORKTREE_ADD_TIMEOUT_MS = 60_000;

export const WORKTREE_CLEANUP_WARNING =
  "Canopy could not finish cleanup. Check the worktree and branch before retrying.";

/** Use Git for checkout and hooks. Reflog intent and an attempt-specific lock make rollback verifiable. */
export async function addWorktree(
  repo: string,
  tree: NewWorktree,
  timeoutMs = LEGACY_WORKTREE_ADD_TIMEOUT_MS,
): Promise<void> {
  const marker = `Canopy worktree creation ${crypto.randomUUID()}`;
  const ref = `refs/heads/${tree.branch}`;
  let branchRejected = false;
  let reservation: Awaited<ReturnType<typeof reserveCheckout>> | undefined;

  try {
    // The empty expected value makes this atomic, even if another client just took the branch name.
    const branch = await git(repo, ["update-ref", "--no-deref", "--create-reflog", "-m", marker, ref, tree.commit, ""]);
    branchRejected = !branch.ok;

    if (branchRejected)
      throw new GitError("WORKTREE_FAILED", "Git could not create the worktree branch. Retry with a different name.");

    reservation = await reserveCheckout(repo, tree.path);

    const checkout = await git(
      repo,
      ["worktree", "add", "--quiet", "--lock", "--reason", marker, "--no-guess-remote", "--", tree.path, tree.branch],
      timeoutMs,
      { finishAfterAdmission: true },
    );

    if (!checkout.ok)
      throw new GitError(
        "WORKTREE_CHECKOUT_FAILED",
        "Git could not check out the worktree. Check the Git settings and filters.",
      );
    await finishCheckout(repo, tree, marker, reservation);
  } catch (error) {
    if (branchRejected) throw error;

    const interrupted =
      error instanceof GitError && error.cause instanceof ProcessTimeoutError ? error.cause : undefined;

    const cleaned =
      (!interrupted || interrupted.treeTerminated) &&
      (await settleWorktreeGit(() => rollbackWorktree(repo, tree, marker, reservation, Boolean(interrupted))).catch(
        () => undefined,
      )) === "removed";

    if (cleaned) throw error;

    const cause =
      error instanceof GitError ? error : new GitError("WORKTREE_FAILED", "Git could not create the worktree.");

    throw new GitError(cause.code, `${cause.message} ${WORKTREE_CLEANUP_WARNING}`, { cause: cause.cause });
  }
}

async function finishCheckout(
  repo: string,
  tree: NewWorktree,
  marker: string,
  reservation: Awaited<ReturnType<typeof reserveCheckout>>,
): Promise<void> {
  await settleWorktreeGit(async () => {
    const entries = atPath(await registeredWorktrees(repo), tree.path);
    const [entry] = entries;

    if (
      entries.length !== 1 ||
      !entry ||
      !ownsCheckout(entry, tree, marker) ||
      !sameEntry(reservation.checkout, physicalDirectory(tree.path))
    )
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
  });
}
