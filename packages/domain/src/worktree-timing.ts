import { ui } from "@canopy/contracts";

export const WORKTREE_CHECKOUT_DEADLINE = "worktree_checkout_deadline_v1";
export const LEGACY_WORKTREE_QUERY_TIMEOUT_MS = 90_000;
export const WORKTREE_CHECKOUT_TIMEOUT_MS = 240_000;
export const WORKTREE_PREPARATION_TIMEOUT_MS = 35_000;
export const WORKTREE_SETTLEMENT_TIMEOUT_MS = 35_000;

// Allow additional time to deliver the worker's result after termination, verification and rollback.
export const WORKTREE_QUERY_TIMEOUT_MS =
  WORKTREE_PREPARATION_TIMEOUT_MS + WORKTREE_CHECKOUT_TIMEOUT_MS + WORKTREE_SETTLEMENT_TIMEOUT_MS + 5_000;

export const WORKTREE_PEER_TIMEOUT_MS = WORKTREE_QUERY_TIMEOUT_MS + 10_000;
export const WORKTREE_DRAFT_TIMEOUT_MS = WORKTREE_PEER_TIMEOUT_MS + 10_000;
export const WORKTREE_CLIENT_TIMEOUT_MS = WORKTREE_DRAFT_TIMEOUT_MS + 10_000;

/** An unspecified main-thread placement can resolve to a new worktree on its home gateway. */
export function threadCreationMayCheckout(
  request: Pick<ui.CreateThreadRequest, "workspaceMode" | "parentThreadId" | "forkThreadId">,
): boolean {
  return (
    request.workspaceMode === ui.WorkspaceMode.NEW_WORKTREE ||
    (request.workspaceMode === ui.WorkspaceMode.UNSPECIFIED && !request.parentThreadId && !request.forkThreadId)
  );
}
