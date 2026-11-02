import { humanizeEnum } from "#lib/shared/humanize.ts";
import { Provider, type ui } from "@open-agents/contracts";
import type { IconName } from "#lib/shared/ui/icons.ts";
import type { Tone } from "#lib/shared/ui/tone.ts";

/**
 * Goals belong to the harness (Codex goals, Claude Code `/goal`); the platform mirrors their state and
 * lets you set, pause, resume and clear them (docs/goals.md). Labels and rules for the UI.
 */
export type GoalAction = "set" | "pause" | "resume" | "clear";

/** The gateway's limit on an objective. */
export const OBJECTIVE_LIMIT = 4000;

export interface GoalLook {
  readonly label: string;
  readonly tone: Tone;
  readonly icon: IconName;
  /** The harness is working on it: the dot pulses. */
  readonly active?: boolean;
}

const looks: Record<string, GoalLook> = {
  active: { label: "Active", tone: "sky", icon: "flag", active: true },
  paused: { label: "Paused", tone: "neutral", icon: "pause" },
  blocked: { label: "Blocked", tone: "rose", icon: "exclamation-circle" },
  budget_limited: { label: "Budget reached", tone: "amber", icon: "exclamation-triangle" },
  usage_limited: { label: "Usage limit", tone: "amber", icon: "exclamation-triangle" },
  achieved: { label: "Achieved", tone: "emerald", icon: "check-circle" },
  cancelled: { label: "Cleared", tone: "neutral", icon: "x-circle" },
};

export const goalLook = (status: string): GoalLook => looks[status] ?? { label: humanizeEnum(status) || "Goal", tone: "neutral", icon: "flag" };

/** Achieved and cancelled goals stay finished; every other status is the thread's open goal. */
export const isFinishedGoal = (status: string): boolean => status === "achieved" || status === "cancelled";

/** Stopped without being finished (blocked, a budget or usage limit): it needs you to resume or clear it. */
export const goalNeedsYou = (status: string): boolean => status === "blocked" || status === "budget_limited" || status === "usage_limited";

/** What you can do with a goal: the gateway pauses only an active one and resumes any other open one. */
export function goalActions(status: string): { pause: boolean; resume: boolean; clear: boolean } {
  const open = !isFinishedGoal(status);
  return { pause: status === "active", resume: open && status !== "active", clear: open };
}

/** Goals are the harness's: a gateway thread (a chat agent in the gateway) has none. */
export const takesGoals = (thread: ui.Thread): boolean => thread.runtime !== "gateway";

/** Only Codex takes a token budget (Claude Code's `/goal` has none; the gateway rejects it). */
export const takesTokenBudget = (provider: Provider): boolean => provider === Provider.CODEX;

/** Codex counts the turns it continued the goal in; Claude Code counts its evaluator's checks. */
export const iterationsLabel = (count: number, provider: Provider): string =>
  provider === Provider.CLAUDE ? `${count} ${count === 1 ? "check" : "checks"}` : `${count} ${count === 1 ? "turn" : "turns"}`;

/** Share of the token budget used (0..1), undefined without a budget. */
export const budgetShare = (goal: ui.Goal): number | undefined =>
  goal.tokenBudget > 0n ? Math.min(1, Number(goal.tokensUsed) / Number(goal.tokenBudget)) : undefined;

/** 45 → "45s", 754 → "12m", 3900 → "1h 5m". */
export function formatElapsed(seconds: bigint | number): string {
  const total = Math.max(0, Math.round(Number(seconds)));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

/**
 * Whether the thread page shows the goal bar: an open goal always; an achieved one until you dismiss it;
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
