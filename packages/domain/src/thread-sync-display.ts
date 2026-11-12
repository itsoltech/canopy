import type { ui } from "@canopy/contracts";
import { formatCount } from "./format.ts";

/** Shared, content-free copy for progress and diagnostic surfaces. */
export function threadSyncProgress(status: Pick<ui.ThreadSyncStatus, "caughtUp" | "remaining" | "reason">) {
  if (status.reason) return "Sync paused";

  if (status.caughtUp) return "Up to date";

  return `${status.remaining} ${status.remaining === 1n ? "record" : "records"} to go`;
}

/** The header indicator stays empty once the thread is caught up; it only reports work or a problem. */
export function threadSyncVisible(status: Pick<ui.ThreadSyncStatus, "caughtUp" | "reason">) {
  return Boolean(status.reason) || !status.caughtUp;
}

/** Tooltip and accessibility label: the failure reason when paused, otherwise the progress. */
export function threadSyncLabel(status: Pick<ui.ThreadSyncStatus, "caughtUp" | "remaining" | "reason">) {
  return status.reason ? `Sync paused: ${threadSyncFailure(status.reason)}` : threadSyncProgress(status);
}

export function threadSyncCount(remaining: bigint) {
  return remaining >= 999_500_000_000_000n ? ">999T" : formatCount(remaining);
}

export function threadSyncFailure(reason: string) {
  switch (reason) {
    case "decode_error":
      return "Unreadable update";
    case "size_limit":
      return "Update too large";
    case "invalid_range":
      return "Missing records";
    case "invalid_cursor":
      return "Sync position unavailable";
    case "invalid_record":
      return "Invalid update";
    case "access_denied":
      return "Access denied";
    case "thread_removed":
      return "Thread removed";
    case "timeout":
      return "Update timed out";
    case "stream_unavailable":
      return "Live updates unavailable";
    default:
      return "Sync paused";
  }
}
