import type { ui } from "@canopy/contracts";
import { REMOTE_THREADS, THREAD_MIRROR } from "@canopy/domain/computers";

/**
 * Linked computers in the thread UI (docs/linked-computers.md, stage 2). Their threads stay at home; this
 * computer keeps a read-only mirror when the peer supports it. Actions always require its home online.
 */
export const computerName = (computer: ui.LinkedComputer | undefined): string => computer ? computer.displayName || computer.name : "The other computer";

/** Connected and new enough to share its threads. */
export const sharesThreads = (computer: ui.LinkedComputer): boolean => computer.status === "connected" && computer.capabilities.includes(REMOTE_THREADS);
/** Offline rows remain visible only when their home supports durable mirrors. */
export const listsThreads = (computer: ui.LinkedComputer): boolean => sharesThreads(computer) || computer.capabilities.includes(THREAD_MIRROR);
export const lastSeen = (computer: ui.LinkedComputer | undefined): string => computer?.lastSeenMs ? `Last seen ${since(computer.lastSeenMs)}` : "Not synced yet";

/** Connected, but an older Canopy that cannot share threads yet. */
export const needsThreadUpdate = (computer: ui.LinkedComputer): boolean => computer.status === "connected" && computer.capabilities.length > 0 && !computer.capabilities.includes(REMOTE_THREADS);
export const needsMirrorUpdate = (computer: ui.LinkedComputer): boolean => sharesThreads(computer) && !computer.capabilities.includes(THREAD_MIRROR);

const time = new Intl.DateTimeFormat("en", { timeStyle: "short" });
const dayTime = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function since(ms: bigint): string {
  const at = new Date(Number(ms));
  return (at.toDateString() === new Date().toDateString() ? time : dayTime).format(at);
}

/** Why a computer's threads cannot be used right now ("Laptop B is unreachable since 7:42 PM"); undefined when they can. */
export function awayReason(computer: ui.LinkedComputer | undefined): string | undefined {
  if (!computer) return "This computer is no longer linked. Its threads stay on it.";
  if (sharesThreads(computer)) return undefined;
  const name = computerName(computer);
  const at = computer.statusSinceMs ? since(computer.statusSinceMs) : "";
  if (needsThreadUpdate(computer)) return `${name} needs an update to share its threads.`;
  switch (computer.status) {
    case "connected": return `${name} is reconnecting.`;
    case "needs_update": return computer.updateNodeId === computer.nodeId ? `${name} needs an update.` : `This computer needs an update to work with ${name}.`;
    case "updating": return `${name} is updating${at && ` since ${at}`}.`;
    case "sleeping": return `${name} went to sleep${at && ` at ${at}`}.`;
    case "shutting_down": return `${name} shut down${at && ` at ${at}`}.`;
    case "pairing_required": return `${name} must be paired again.`;
    default: return `${name} is unreachable${at && ` since ${at}`}.`;
  }
}
