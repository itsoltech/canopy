import type { ui } from "@canopy/contracts";
import { REMOTE_THREADS, THREAD_MIRROR } from "@canopy/domain/computers";
import { workerStatus } from "#lib/features/overview/workers.ts";

/**
 * Linked computers in the thread UI (docs/linked-computers.md, stage 2). Their threads stay at home; this
 * computer keeps a read-only mirror when the peer supports it. Actions always require its home online.
 */
export const computerName = (computer: ui.LinkedComputer | undefined): string =>
  computer ? computer.displayName || computer.name : "The other computer";

/** Connected and new enough to share its threads. */
export const sharesThreads = (computer: ui.LinkedComputer): boolean =>
  !computer.relayOrigin && computer.status === "connected" && computer.capabilities.includes(REMOTE_THREADS);

/** Offline rows remain visible only when their home supports durable mirrors. */
export const listsThreads = (computer: ui.LinkedComputer): boolean =>
  !computer.relayOrigin && (sharesThreads(computer) || computer.capabilities.includes(THREAD_MIRROR));

/** Connected, but an older Canopy that cannot share threads yet. */
export const needsThreadUpdate = (computer: ui.LinkedComputer): boolean =>
  !computer.relayOrigin &&
  computer.status === "connected" &&
  computer.capabilities.length > 0 &&
  !computer.capabilities.includes(REMOTE_THREADS);

export const needsMirrorUpdate = (computer: ui.LinkedComputer): boolean =>
  sharesThreads(computer) && !computer.capabilities.includes(THREAD_MIRROR);

const time = new Intl.DateTimeFormat("en", { timeStyle: "short" });
const dayTime = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function presenceTime(ms: bigint): string {
  const at = new Date(Number(ms));

  return (at.toDateString() === new Date().toDateString() ? time : dayTime).format(at);
}

/** Short presence labels for read-only threads; `awayReason` keeps the full explanation. */
export function awayStatus(computer: ui.LinkedComputer | undefined): string {
  if (!computer) return "no longer linked";

  if (computer.relayOrigin) return "access unavailable";

  if (needsThreadUpdate(computer)) return "needs an update";

  if (computer.unavailableReason && sharesThreads(computer)) return "unavailable";

  switch (computer.status) {
    case "connected":
      return "reconnecting…";
    case "needs_update":
      return "update needed";
    case "updating":
      return "updating…";
    case "sleeping":
      return "asleep";
    case "shutting_down":
      return "offline";
    case "pairing_required":
      return "needs pairing";
    default:
      return "unreachable";
  }
}

/** Why a computer's threads cannot be used right now ("Laptop B is unreachable since 7:42 PM"); undefined when they can. */
export function awayReason(computer: ui.LinkedComputer | undefined): string | undefined {
  if (!computer) return "This computer is no longer linked. Its threads stay on it.";

  if (computer.relayOrigin)
    return `This entry shows access through ${computer.viaName}; it does not share that computer's threads.`;

  if (computer.unavailableReason) return computer.unavailableReason;

  if (sharesThreads(computer)) return undefined;
  const name = computerName(computer);
  const at = computer.statusSinceMs ? presenceTime(computer.statusSinceMs) : "";

  if (needsThreadUpdate(computer)) return `${name} needs an update to share its threads.`;

  switch (computer.status) {
    case "connected":
      return `${name} is reconnecting.`;
    case "needs_update":
      return computer.updateNodeId === computer.nodeId
        ? `${name} needs an update.`
        : `This computer needs an update to work with ${name}.`;
    case "updating":
      return `${name} is updating${at && ` since ${at}`}.`;
    case "sleeping":
      return `${name} went to sleep${at && ` at ${at}`}.`;
    case "shutting_down":
      return `${name} shut down${at && ` at ${at}`}.`;
    case "pairing_required":
      return `${name} must be paired again.`;
    default:
      return `${name} is unreachable${at && ` since ${at}`}.`;
  }
}

/** A worker's short presence in pickers ("Online", "Updating…"), counting its computer's link for a linked one. */
export function workerPresence(worker: ui.Worker, computer: ui.LinkedComputer | undefined) {
  const reason = worker.nodeId ? awayReason(computer) : undefined;

  if (!reason) return { online: worker.online, status: workerStatus(worker), reason };

  return { online: false, status: awayLabels.get(computer?.status ?? "") ?? "Unreachable", reason };
}

const awayLabels = new Map([
  ["updating", "Updating…"],
  ["sleeping", "Going to sleep"],
  ["shutting_down", "Shutting down"],
  ["needs_update", "Needs an update"],
  ["pairing_required", "Pair again"],
  ["connected", "Reconnecting…"],
]);
