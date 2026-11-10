import type { ui } from "@canopy/contracts";
import { presenceLabel, awayReason, computerName, formatPresenceTime } from "@canopy/domain/computer-presence";
import { useOverview } from "../../state/overview";
import { nodeRef } from "@canopy/domain/computers";

/** "7:42 PM" today, "Nov 5, 7:42 PM" before. */
export const presenceTime = formatPresenceTime;

/** Presence beside a mirrored thread or bot, independent of the phone's gateway connection. */
export function useComputerHome(nodeId: string | undefined) {
  const { computers } = useOverview();
  const computer = nodeId ? computers.find((c) => c.nodeId === nodeId || nodeRef(c.nodeId) === nodeId) : undefined;
  const reason = nodeId ? awayReason(computer, presenceTime) : undefined;

  return {
    away: Boolean(reason),
    reason,
    name: computerName(computer),
    status: presenceLabel(computer?.status ?? "unreachable", computer?.statusSinceMs ?? 0n, presenceTime),
  };
}

export interface WorkerPresence {
  /** "This computer" or the linked computer's name. */
  computer: string;
  /** On a linked computer this one cannot reach now: greyed out in pickers. */
  away: boolean;
  online: boolean;
  /** "Online", "Offline", "Unreachable", "Updating…". */
  status: string;
  /** Why it cannot be used ("Laptop B is unreachable since 7:42 PM."). */
  reason?: string;
}

/** Each worker's computer and presence, counting its computer's link for a linked one (as the web pickers do). */
export function useWorkerPresence() {
  const { computers } = useOverview();

  return (worker: ui.Worker | undefined): WorkerPresence => {
    if (!worker?.nodeId)
      return { computer: "This computer", away: false, online: Boolean(worker?.online), status: status(worker) };
    const computer = computers.find((c) => c.nodeId === worker.nodeId);
    const reason = awayReason(computer, presenceTime);
    const name = computerName(computer);

    if (!reason) return { computer: name, away: false, online: worker.online, status: status(worker) };

    return {
      computer: name,
      away: true,
      online: false,
      status: presenceLabel(computer?.status ?? "unreachable", computer?.statusSinceMs ?? 0n, presenceTime),
      reason,
    };
  };
}

/** Collapsed controls show only the worker; picker rows disambiguate duplicate names. */
export function useWorkerLabel() {
  const { workers } = useOverview();

  return (id: string) => {
    const worker = workers.find((row) => row.id === id);

    return worker?.name ?? "Unknown worker";
  };
}

const status = (worker: ui.Worker | undefined) => (worker?.online ? "Online" : "Offline");
