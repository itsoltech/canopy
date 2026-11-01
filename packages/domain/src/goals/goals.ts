/**
 * Platform goals (docs/goals.md): the platform owns the goal (durable, visible, budgeted across
 * the thread tree); the harness's native goal feature is the default engine underneath.
 *
 * - Codex: thread/goal/* (objective + token budget; Codex continues idle threads with an active goal,
 *   the model reports complete/blocked through update_goal).
 * - Claude: /goal <condition> (a Stop-hook evaluator keeps the turn going until the condition is met;
 *   progress arrives as active_goal messages).
 * - Platform engine (fallback): the gateway starts continuation turns itself (trigger = goal).
 */

export type GoalStatus =
  | "proposed" // suggested by an agent, waiting for user approval
  | "active"
  | "paused"
  | "blocked" // the agent reports it cannot progress
  | "budget_limited" // platform or native budget exhausted
  | "usage_limited" // provider usage limits
  | "achieved"
  | "cancelled";

export type GoalEngine = "native" | "platform";

/**
 * Decided 2026-11-01: the harness's native goal feature drives goals for both providers
 * (Codex audit-driven completion, Claude Stop-hook evaluator). The platform engine stays as a
 * fallback per goal. Matches goals.engine DEFAULT 'native' in the schema.
 */
export const DEFAULT_GOAL_ENGINE: GoalEngine = "native";
export type GoalActor = "user" | "agent" | "system";

export interface GoalBudget {
  readonly tokens?: number;
  readonly costUsd?: number;
  readonly seconds?: number;
  /** Continuation turns (platform engine) or evaluator iterations (Claude). */
  readonly turns?: number;
}

export interface GoalUsage {
  readonly tokens: number;
  readonly costUsd: number;
  readonly seconds: number;
  readonly turns: number;
}

/**
 * Allowed transitions per actor. The model may only claim the outcome (achieved/blocked);
 * pausing, resuming and cancelling are the user's; limits are the system's.
 */
const TRANSITIONS: Readonly<Record<GoalActor, ReadonlyArray<readonly [GoalStatus, GoalStatus]>>> = {
  agent: [
    ["active", "achieved"],
    ["active", "blocked"],
  ],
  user: [
    ["proposed", "active"],
    ["proposed", "cancelled"],
    ["active", "paused"],
    ["active", "cancelled"],
    ["active", "achieved"],
    ["paused", "active"],
    ["paused", "cancelled"],
    ["blocked", "active"],
    ["blocked", "cancelled"],
    ["budget_limited", "active"],
    ["budget_limited", "cancelled"],
    ["usage_limited", "active"],
    ["usage_limited", "cancelled"],
    ["achieved", "active"], // reopen
  ],
  system: [
    ["active", "budget_limited"],
    ["active", "usage_limited"],
    ["active", "achieved"], // evaluator (Claude) or native completion
    ["active", "blocked"], // native engine reported blocked
    ["usage_limited", "active"], // provider limits reset
  ],
};

export function canTransition(from: GoalStatus, to: GoalStatus, actor: GoalActor): boolean {
  return TRANSITIONS[actor].some(([a, b]) => a === from && b === to);
}

/** Statuses in which the engine keeps working. */
export function isRunning(status: GoalStatus): boolean {
  return status === "active";
}

/** First exceeded budget, as a readable reason; undefined while within budget. */
export function budgetExceeded(budget: GoalBudget, usage: GoalUsage): string | undefined {
  if (budget.tokens !== undefined && usage.tokens >= budget.tokens) return `token budget (${budget.tokens}) used`;
  if (budget.costUsd !== undefined && usage.costUsd >= budget.costUsd) return `cost budget ($${budget.costUsd}) used`;
  if (budget.seconds !== undefined && usage.seconds >= budget.seconds) return `time budget (${budget.seconds}s) used`;
  if (budget.turns !== undefined && usage.turns >= budget.turns) return `continuation limit (${budget.turns}) reached`;
  return undefined;
}

/** Agent-created goals must be bounded; users may create open-ended ones. */
export function validateGoalBudget(budget: GoalBudget, actor: GoalActor): string | undefined {
  const values = [budget.tokens, budget.costUsd, budget.seconds, budget.turns];
  if (values.some((v) => v !== undefined && (!Number.isFinite(v) || v <= 0))) return "budgets must be positive numbers";
  if (actor !== "user" && values.every((v) => v === undefined)) return "agent goals need at least one budget";
  return undefined;
}

// ------------------------------------------------------------------ native engines

export interface GoalText {
  /** What to achieve. */
  readonly objective: string;
  /** How to tell it is done, verifiable from the conversation (tests pass, file exists, ...). */
  readonly condition: string;
}

/** Codex has a single objective; the completion condition is appended so its audit checks against it. */
export function codexObjective(goal: GoalText): string {
  return goal.condition ? `${goal.objective}\n\nDone when: ${goal.condition}` : goal.objective;
}

export type CodexGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export function fromCodexStatus(status: CodexGoalStatus): GoalStatus {
  switch (status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "usageLimited":
      return "usage_limited";
    case "budgetLimited":
      return "budget_limited";
    case "complete":
      return "achieved";
  }
}

/** What to tell Codex for a platform status: set a status, or clear the native goal. */
export function toCodexGoal(status: GoalStatus): { readonly set: CodexGoalStatus } | { readonly clear: true } {
  switch (status) {
    case "active":
      return { set: "active" };
    case "achieved":
      return { set: "complete" };
    case "cancelled":
      return { clear: true };
    default:
      // proposed, paused, blocked and limits: stop native continuation, keep the native goal.
      return { set: "paused" };
  }
}

/** Claude's goal is driven by slash commands in the input stream. */
export function claudeGoalInput(goal: GoalText, status: GoalStatus): string {
  return isRunning(status) ? `/goal ${goal.condition || goal.objective}` : "/goal clear";
}

export interface ClaudeActiveGoal {
  readonly condition: string;
  readonly iterations: number;
  readonly last_reason?: string;
}

/**
 * Interprets Claude's active_goal message. The value becomes null both when the evaluator reports
 * the condition met and when the goal is cleared; only the platform knows whether it asked to clear.
 */
export function fromClaudeActiveGoal(
  value: ClaudeActiveGoal | null,
  clearRequested: boolean,
): { readonly status: GoalStatus | "unchanged"; readonly iterations?: number; readonly reason?: string } {
  if (value === null) return { status: clearRequested ? "unchanged" : "achieved" };
  return {
    status: "active",
    iterations: value.iterations,
    ...(value.last_reason !== undefined && { reason: value.last_reason }),
  };
}
