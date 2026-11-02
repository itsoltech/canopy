import { humanizeEnum } from "../humanize.ts";
import type { Tone } from "./tone.ts";

export interface StatusLook {
  readonly label: string;
  readonly tone: Tone;
  /** Work in progress: the dot pulses. */
  readonly active?: boolean;
}

/** Statuses of threads (`ui.Thread.status`), turns (`ui.Turn.status`), interactions and workers. */
const looks: Record<string, StatusLook> = {
  creating: { label: "Starting", tone: "sky", active: true },
  idle: { label: "Idle", tone: "emerald" },
  running: { label: "Running", tone: "sky", active: true },
  waiting_input: { label: "Needs input", tone: "amber", active: true },
  interrupted: { label: "Interrupted", tone: "orange" },
  failed: { label: "Failed", tone: "rose" },
  archived: { label: "Archived", tone: "neutral" },
  queued: { label: "Queued", tone: "neutral" },
  completed: { label: "Completed", tone: "emerald" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  pending: { label: "Pending", tone: "amber", active: true },
  allowed: { label: "Allowed", tone: "emerald" },
  declined: { label: "Declined", tone: "rose" },
  answered: { label: "Answered", tone: "emerald" },
  expired: { label: "Expired", tone: "neutral" },
  online: { label: "Online", tone: "emerald" },
  offline: { label: "Offline", tone: "neutral" },
};

export function statusLook(status: string): StatusLook {
  return looks[status] ?? { label: humanizeEnum(status) || "Unknown", tone: "neutral" };
}
