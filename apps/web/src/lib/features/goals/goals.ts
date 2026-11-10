import { Provider, type ui } from "@canopy/contracts";

/**
 * Goals belong to the harness (Codex goals, Claude Code `/goal`); the platform mirrors their state and
 * lets you set, pause, resume and clear them (docs/goals.md). Labels and rules for the UI.
 */
export type GoalAction = "set" | "pause" | "resume" | "clear";

/** The gateway's limit on an objective. */
export const OBJECTIVE_LIMIT = 4000;

export { goalActions, goalLook, goalPending, isFinishedGoal, showsGoal } from "@canopy/domain/goals";

export type { GoalActions, GoalLook } from "@canopy/domain/goals";

/** Stopped without being finished (blocked, a budget or usage limit): it needs you to resume or clear it. */
export const goalNeedsYou = (status: string): boolean =>
  status === "blocked" || status === "budget_limited" || status === "usage_limited";

/** Goals are the harness's: a gateway thread (a chat agent in the gateway) has none. */
export const takesGoals = (thread: ui.Thread): boolean =>
  thread.runtime !== "gateway" && thread.provider !== Provider.GROK;

/** Only Codex takes a token budget (Claude Code's `/goal` has none; the gateway rejects it). */
export const takesTokenBudget = (provider: Provider): boolean => provider === Provider.CODEX;

/** Codex counts the turns it continued the goal in; Claude Code counts its evaluator's checks. */
export const iterationsLabel = (count: number, provider: Provider): string =>
  provider === Provider.CLAUDE
    ? `${count} ${count === 1 ? "check" : "checks"}`
    : `${count} ${count === 1 ? "turn" : "turns"}`;

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
