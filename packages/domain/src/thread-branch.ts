import type { ui } from "@canopy/contracts";
import { REMOTE_BRANCH_SWITCH } from "./computers.ts";

/** Shared web/mobile availability; the home and worker independently enforce these conditions. */
export function branchSwitchReason(thread: ui.Thread, worker: ui.Worker | undefined, home?: ui.LinkedComputer): string {
  if (thread.nodeId && !home?.capabilities.includes(REMOTE_BRANCH_SWITCH))
    return "Update the home computer to switch branches.";

  if (!worker?.online) return "Reconnect this computer to switch branches.";

  if (!worker.branchSwitch) return "Update this computer to switch branches.";

  if (thread.archivedAt || thread.deletedAt) return "Open an active thread to switch branches.";

  if (thread.goalStatus && !["achieved", "cancelled"].includes(thread.goalStatus))
    return "Clear the thread's goal before switching branches.";

  if (
    thread.turnStarting ||
    ["creating", "running", "waiting_input"].includes(thread.status) ||
    thread.pendingInteractions ||
    thread.backgroundTasks
  )
    return "Wait for the turn and background tasks to finish before switching.";

  return "";
}

/** Keep the directory name prominent without losing any part of a remote POSIX or Windows path. */
export function placementPath(path: string, home = "") {
  const normalized = path.replaceAll("\\", "/");

  const prefix =
    home.replaceAll("\\", "/").replace(/\/$/, "") ||
    normalized.match(/^(?:\/home\/[^/]+|\/Users\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/)?.[0];

  const shown =
    prefix && (normalized === prefix || normalized.startsWith(`${prefix}/`))
      ? `~${normalized.slice(prefix.length)}`
      : normalized;

  const split = shown.replace(/\/$/, "").lastIndexOf("/");

  return { parent: split >= 0 ? shown.slice(0, split + 1) : "", name: split >= 0 ? shown.slice(split + 1) : shown };
}
