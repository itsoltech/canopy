import type { ui } from "@canopy/contracts";
import {
  presenceLabel,
  formatPresenceTime,
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

export function presenceTime(ms: bigint): string {
  return formatPresenceTime(ms, clockOptions());
}

/** Short presence labels for read-only threads; `awayReason` keeps the full explanation. */
export function awayStatus(computer: ui.LinkedComputer | undefined): string {
  if (!computer) return "no longer linked";

  if (computer.relayOrigin) return "access unavailable";

  if (needsThreadUpdate(computer)) return "needs an update";

  if (computer.unavailableReason && sharesThreads(computer)) return "unavailable";

  return presenceLabel(computer.status, computer.statusSinceMs, presenceTime);
}

/** Why a computer's threads cannot be used right now ("Laptop B is unreachable since 7:42 PM"); undefined when they can. */
export const awayReason = (computer: ui.LinkedComputer | undefined): string | undefined =>
  presenceReason(computer, presenceTime);

/** A worker's short presence in pickers ("Online", "Updating…"), counting its computer's link for a linked one. */
export function workerPresence(worker: ui.Worker, computer: ui.LinkedComputer | undefined) {
  const reason = worker.nodeId ? awayReason(computer) : undefined;

  if (!reason) return { online: worker.online, status: workerStatus(worker), reason };

  return { online: false, status: awayStatus(computer), reason };
}
