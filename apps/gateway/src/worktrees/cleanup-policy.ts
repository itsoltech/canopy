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

/** Closing every sharing thread grants disposal only through its enabled lifecycle rule. */
export function closedThreadCleanup(row: WorktreeLifecycleRow, settings: ui.WorktreeSettings): boolean {
  return Boolean((settings.cleanupDeletedThreads && row.all_deleted) || (settings.cleanupSettled && row.all_archived));
}

/** Rules are alternatives; active resources and worktree boundaries always block removal. */
export function cleanupReason(
  row: WorktreeLifecycleRow,
  status: WorktreeStatus,
  settings: ui.WorktreeSettings,
  now = new Date(),
): string {
  if (row.archive_grace_period) return "Kept: archived less than 24 hours ago";

  if (settings.cleanupDeletedThreads && row.all_deleted) return "All threads deleted";

  // The proto field keeps its old name; the rule now covers archived threads only.
  if (settings.cleanupSettled && row.all_archived) return "All threads archived";

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
  return !row.archive_grace_period && cleanupReason(row, status, settings) !== "No cleanup policy matches";
}
