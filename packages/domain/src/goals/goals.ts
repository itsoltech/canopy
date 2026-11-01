/**
 * Goals (docs/goals.md, decided 2026-11-01): the harness's own goal feature is the engine, the platform
 * tracks and shows it and lets the user set, pause, resume and clear it.
 *
 * - Codex: thread/goal/set|clear (objective + token budget). Codex continues an idle thread with an active
 *   goal by itself (provider turns) and reports thread/goal/updated|cleared.
 * - Claude: `/goal <condition>` in the input stream starts a turn; a Stop-hook evaluator keeps it going until
 *   the condition is met. `/goal clear` removes it. There is no native pause.
 *
 * The platform goal engine (gateway continuation turns, goal tools on the agent bus) is not built; the
 * transition and budget rules below remain for the agent bus goal tools (policy.ts), which are off.
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

// ------------------------------------------------------------------ harness goals

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

/** What the Claude adapter reports (GoalState.native_status). */
export type ClaudeGoalStatus = "active" | "met" | "failed" | "cleared";

/**
 * Platform status for a harness report. `current` is the status the platform holds: a pause or clear the
 * user asked for is not undone by the harness confirming it (Claude has no pause: the platform clears the
 * goal and keeps it as paused).
 */
export function goalStatusFromHarness(provider: "codex" | "claude", nativeStatus: string, cleared: boolean, current: GoalStatus | undefined): GoalStatus {
  if (cleared || nativeStatus === "cleared") {
    return current === "paused" || current === "achieved" || current === "cancelled" ? current : "cancelled";
  }
  if (provider === "codex") {
    const status = isCodexGoalStatus(nativeStatus) ? fromCodexStatus(nativeStatus) : "active";
    // The pause was the user's; Codex may still report the running turn's progress as active.
    return current === "paused" && status === "active" ? "paused" : status;
  }
  switch (nativeStatus as ClaudeGoalStatus) {
    case "met":
      return "achieved";
    case "failed":
      return "blocked";
    default:
      return current === "paused" ? "paused" : "active";
  }
}

/** Finished goals free the thread for a new one (goals_one_open). */
export function isFinished(status: GoalStatus): boolean {
  return status === "achieved" || status === "cancelled";
}

/** Claude's goal is driven by slash commands in the input stream. */
export function claudeGoalCommand(objective: string | undefined): string {
  return objective ? `/goal ${objective}` : "/goal clear";
}

function isCodexGoalStatus(status: string): status is CodexGoalStatus {
  return ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(status);
}
