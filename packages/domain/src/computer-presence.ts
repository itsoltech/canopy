import type { ui } from "@canopy/contracts";
import { REMOTE_THREADS, THREAD_MIRROR } from "./computers.ts";

/** A planned update/restart that never comes back becomes an unexplained loss after five minutes. */
export const DEPARTURE_WINDOW_MS = 5 * 60_000;
export const RESTART_PRESENCE = "restart_presence";

export const announcedDeparture = (status: string) =>
  ["updating", "restarting", "sleeping", "shutting_down"].includes(status);

/** Presence timestamps use the local clock, with a date for earlier days. */
export function formatPresenceTime(ms: bigint, options: Intl.DateTimeFormatOptions = {}): string {
  const at = new Date(Number(ms));

  return new Intl.DateTimeFormat("en", {
    ...(at.toDateString() !== new Date().toDateString() && { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
    ...options,
  }).format(at);
}

/** Never substitute a gateway or peer refresh time for the app's actual feed check. */
export function updateCheckLabel(ms: number | undefined, time = formatPresenceTime): string {
  return ms ? `Checked ${time(BigInt(ms))}` : "Check time unavailable";
}

/** Shared wording for web/mobile settings, pickers, read-only bars and update rows. */
export function presenceLabel(status: string, since: bigint, time: (ms: bigint) => string): string {
  const label = status === "connected" ? "Connected" : (awayLabels.get(status) ?? "Unreachable");

  return since && ["sleeping", "shutting_down", "unreachable"].includes(status)
    ? `${label} since ${time(since)}`
    : label;
}

/**
 * Linked computers in the thread UI (docs/linked-computers.md, stage 2), shared by the web and the phone app. Their
 * threads stay at home; this computer keeps a read-only mirror when the peer supports it. Actions always require its
 * home online. Times are formatted by the caller (`presenceTime`), which knows its clock settings.
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

/** Why a computer's threads cannot be used right now ("Laptop B is unreachable since 7:42 PM"); undefined when they can. */
export function awayReason(
  computer: ui.LinkedComputer | undefined,
  presenceTime: (ms: bigint) => string,
): string | undefined {
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
    case "restarting":
      return `${name} is restarting${at && ` since ${at}`}.`;
    case "sleeping":
      return `${name} is asleep${at && ` since ${at}`}.`;
    case "shutting_down":
      return `${name} is offline${at && ` since ${at}`}.`;
    case "pairing_required":
      return `${name} must be paired again.`;
    default:
      return `${name} is unreachable${at && ` since ${at}`}.`;
  }
}

/** A worker's short status while its linked computer cannot be used ("Updating…"); "Unreachable" otherwise. */
export const awayLabel = (computer: ui.LinkedComputer | undefined): string =>
  awayLabels.get(computer?.status ?? "") ?? "Unreachable";

const awayLabels = new Map([
  ["updating", "Updating…"],
  ["restarting", "Restarting…"],
  ["sleeping", "Asleep"],
  ["shutting_down", "Offline"],
  ["needs_update", "Needs an update"],
  ["pairing_required", "Pair again"],
  ["connected", "Reconnecting…"],
]);
