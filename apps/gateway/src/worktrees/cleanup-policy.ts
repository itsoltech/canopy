import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { WorktreeStatus, ui } from "@canopy/contracts";
import type { WorktreeLifecycleRow } from "../store/worktree-lifecycle.ts";

export function lastActivity(row: WorktreeLifecycleRow, status?: WorktreeStatus): Date {
  return new Date(
    Math.max(
      new Date(row.last_activity_at).getTime(),
      status?.lastActivityAt ? timestampDate(status.lastActivityAt).getTime() : 0,
    ),
  );
}

/** Rules are alternatives; safety checks apply to every rule, including manual removal. */
export function cleanupReason(
  row: WorktreeLifecycleRow,
  status: WorktreeStatus,
  settings: ui.WorktreeSettings,
  now = new Date(),
): string {
  if (settings.cleanupDeletedThreads && row.all_deleted) return "All threads deleted";

  if (settings.cleanupSettled && row.all_settled) return "All threads settled";

  if (settings.cleanupMerged && status.merged) return "Branch merged into the default or base branch";

  if (
    settings.cleanupInactiveDays &&
    now.getTime() - lastActivity(row, status).getTime() >= settings.cleanupInactiveDays * 86_400_000
  )
    return `Inactive for ${settings.cleanupInactiveDays} days`;

  if (settings.cleanupUnchanged && status.unchanged) return "Unchanged since creation";

  return "No cleanup policy matches";
}

export function matchesCleanup(
  row: WorktreeLifecycleRow,
  status: WorktreeStatus,
  settings: ui.WorktreeSettings,
): boolean {
  return cleanupReason(row, status, settings) !== "No cleanup policy matches";
}
