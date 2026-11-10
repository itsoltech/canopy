import type { ui } from "@canopy/contracts";
import type { IconName } from "@canopy/ui/icons";
import { humanizeEnum } from "../humanize.ts";
import type { Tone } from "../status-look.ts";

/** How a goal's status looks on web and mobile: the bar above the composer, marks and turn labels. */
export interface GoalLook {
  readonly label: string;
  readonly tone: Tone;
  readonly icon: IconName;
  /** The harness is working on it: the dot pulses. */
  readonly active?: boolean;
}

const looks = new Map<string, GoalLook>([
  ["active", { label: "Active", tone: "sky", icon: "flag", active: true }],
  ["paused", { label: "Paused", tone: "neutral", icon: "pause" }],
  ["blocked", { label: "Blocked", tone: "rose", icon: "exclamation-circle" }],
  ["budget_limited", { label: "Budget reached", tone: "amber", icon: "exclamation-triangle" }],
  ["usage_limited", { label: "Usage limit", tone: "amber", icon: "exclamation-triangle" }],
  ["achieved", { label: "Achieved", tone: "emerald", icon: "check-circle" }],
  ["cancelled", { label: "Cleared", tone: "neutral", icon: "x-circle" }],
]);

export const goalLook = (status: string): GoalLook =>
  looks.get(status) ?? { label: humanizeEnum(status) || "Goal", tone: "neutral", icon: "flag" };

/** Achieved and cancelled goals stay finished; every other status is the thread's open goal. */
export const isFinishedGoal = (status: string): boolean => status === "achieved" || status === "cancelled";

export interface GoalActions {
  pause: boolean;
  resume: boolean;
  clear: boolean;
}

/** What you can do with a goal: the gateway pauses only an active one and resumes any other open one. */
export function goalActions(status: string): GoalActions {
  const open = !isFinishedGoal(status);

  return { pause: status === "active", resume: open && status !== "active", clear: open };
}

/**
 * Whether the thread shows the goal bar: an open goal always; an achieved one until you dismiss it;
 * a cleared one never (you cleared it, or a new goal replaced it).
 */
export const showsGoal = (goal: ui.Goal | undefined, dismissed: ReadonlySet<string>): goal is ui.Goal =>
  Boolean(goal) && goal!.status !== "cancelled" && !(isFinishedGoal(goal!.status) && dismissed.has(goal!.id));

/**
 * Your decision is stored at once, the harness confirms it with its next report (`native_status`).
 * Until then the bar says what it is waiting for; undefined once the harness agrees, or when the command
 * failed on the worker (`error`: nothing is on its way).
 */
export function goalPending(goal: ui.Goal): string | undefined {
  if (goal.error) return undefined;
  const native = goal.nativeStatus;

  if (goal.status === "active" && native === "") return "Starting…";

  if (goal.status === "active" && (native === "paused" || native === "cleared")) return "Resuming…";

  if (goal.status === "paused" && native === "active") return "Pausing…";

  return undefined;
}
