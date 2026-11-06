import type { ui } from "@canopy/contracts";
import {
  awayLabel,
  awayReason as presenceReason,
  needsThreadUpdate,
  sharesThreads,
} from "@canopy/domain/computer-presence";
import { workerStatus } from "#lib/features/overview/workers.ts";
import { clockOptions } from "#lib/shared/format.ts";

/**
 * Linked computers in the thread UI (docs/linked-computers.md, stage 2): presence with this app's clock. Their threads stay at home; this
 * computer keeps a read-only mirror when the peer supports it. Actions always require its home online.
 */

const time = () => new Intl.DateTimeFormat("en", { timeStyle: "short", ...clockOptions() });

const dayTime = () =>
  new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...clockOptions(),
  });

export function presenceTime(ms: bigint): string {
  const at = new Date(Number(ms));

  return (at.toDateString() === new Date().toDateString() ? time : dayTime)().format(at);
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
export const awayReason = (computer: ui.LinkedComputer | undefined): string | undefined =>
  presenceReason(computer, presenceTime);

/** A worker's short presence in pickers ("Online", "Updating…"), counting its computer's link for a linked one. */
export function workerPresence(worker: ui.Worker, computer: ui.LinkedComputer | undefined) {
  const reason = worker.nodeId ? awayReason(computer) : undefined;

  if (!reason) return { online: worker.online, status: workerStatus(worker), reason };

  return { online: false, status: awayLabel(computer), reason };
}
