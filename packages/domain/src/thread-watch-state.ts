import type { ui } from "@canopy/contracts";

/** null preserves readiness: controls, metadata and heartbeats do not start a new catch-up. */
export function threadWatchReady(update: ui.ThreadUpdate): boolean | null {
  if (update.syncing || update.syncStatus?.reason) return false;

  if (update.change.case === "snapshot") return true;

  if (update.change.case === "batch") return update.change.value.caughtUp;

  return null;
}
