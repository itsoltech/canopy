import { populateAgentWorktree } from "./agent-checkout.ts";
import { ProcessTimeoutError } from "@canopy/process-governor";
import { git, GitError, settleWorktreeGit } from "./git.ts";
import {
  atPath,
  ownsCheckout,
  ownsMetadata,
  registeredWorktrees,
  reserveCheckout,
  rollbackWorktree,
  type NewWorktree,
} from "./worktree-rollback.ts";
import { physicalDirectory, sameEntry } from "./worktree-rollback-files.ts";
import type { FailedWorktreeCleanup } from "./failed-worktree-cleanup.ts";

/** Used by gateways that still wait only 90 seconds for the entire command. */
const LEGACY_WORKTREE_ADD_TIMEOUT_MS = 60_000;

export const WORKTREE_CLEANUP_WARNING =
  "Canopy could not finish cleanup. Check the worktree and branch before retrying.";

const seconds = new Intl.NumberFormat("en", { maximumFractionDigits: 3, useGrouping: false });

/** Use Git for checkout and hooks. Reflog intent and an attempt-specific lock make rollback verifiable. */
export async function addWorktree(
  repo: string,
  tree: NewWorktree,
  timeoutMs = LEGACY_WORKTREE_ADD_TIMEOUT_MS,
  cleanup?: FailedWorktreeCleanup,
  agentRequested = false,
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
      [
        "worktree",
        "add",
        "--quiet",
        "--lock",
        "--reason",
        marker,
        "--no-guess-remote",
        ...(agentRequested ? ["--no-checkout"] : []),
        "--",
        tree.path,
        tree.branch,
      ],
      timeoutMs,
      { finishAfterAdmission: !agentRequested },
    ).catch(checkoutError);

    if (!checkout.ok)
      throw new GitError(
        "WORKTREE_CHECKOUT_FAILED",
        "Git could not check out the worktree. Check the Git settings and filters.",
      );

    if (agentRequested) {
      if (
        !sameEntry(reservation.checkout, physicalDirectory(tree.path)) ||
        !ownsMetadata(tree, reservation.metadata, marker)
      )
        throw new GitError("WORKTREE_FAILED", "The registered worktree changed during creation.");
      await populateAgentWorktree(tree, reservation.metadata, timeoutMs).catch(checkoutError);
    }

    await finishCheckout(repo, tree, marker, reservation);
  } catch (error) {
    if (branchRejected) throw error;

    const interrupted =
      error instanceof GitError && error.cause instanceof ProcessTimeoutError ? error.cause : undefined;

    const stoppedAt = interrupted?.treeTerminated ? BigInt(Date.now() + 1) * 1_000_000n : undefined;

    const cleaned =
      (!interrupted || interrupted.treeTerminated) &&
      (await settleWorktreeGit(() => rollbackWorktree(repo, tree, marker, reservation, Boolean(interrupted))).catch(
        () => undefined,
      )) === "removed";

    if (cleaned) throw error;

    if (cleanup && stoppedAt && reservation) {
      try {
        cleanup.rememberStopped(tree, marker, reservation, stoppedAt);
      } catch {
        // Keep the original error and warning if a cleanup receipt cannot be recorded.
      }
    }

    const cause =
      error instanceof GitError ? error : new GitError("WORKTREE_FAILED", "Git could not create the worktree.");

    throw new GitError(cause.code, `${cause.message} ${WORKTREE_CLEANUP_WARNING}`, { cause: cause.cause });
  }
}

function checkoutError(error: Error): never {
  if (
    error instanceof GitError &&
    error.code === "GIT_TIMEOUT" &&
    error.cause instanceof ProcessTimeoutError &&
    error.cause.timing
  ) {
    const { elapsedMs, limitMs } = error.cause.timing;

    throw new GitError(
      error.code,
      `Git timed out after ${seconds.format(elapsedMs / 1000)} s while creating the worktree. The limit was ${seconds.format(limitMs / 1000)} s.`,
      { cause: error.cause },
    );
  }

  throw error;
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
