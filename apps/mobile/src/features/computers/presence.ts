import type { ui } from "@canopy/contracts";
import { awayLabel, awayReason, computerName } from "@canopy/domain/computer-presence";
import { useOverview } from "../../state/overview";

const time = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
const dayTime = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "7:42 PM" today, "Nov 5, 7:42 PM" before. */
function presenceTime(ms: bigint) {
  const at = new Date(Number(ms));

  return (at.toDateString() === new Date().toDateString() ? time : dayTime).format(at);
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

    return { computer: name, away: true, online: false, status: awayLabel(computer), reason };
  };
}

const status = (worker: ui.Worker | undefined) => (worker?.online ? "Online" : "Offline");
