/**
 * Goals (docs/goals.md, decided 2026-11-01): the harness's own goal feature is the engine, the platform
 * tracks and shows it and lets the user set, pause, resume and clear it.
 *
 * - Codex: thread/goal/set|clear (objective + token budget). Codex continues an idle thread with an active
 *   goal by itself (provider turns) and reports thread/goal/updated|cleared.
 * - Claude: `/goal <condition>` in the input stream starts a turn; a Stop-hook evaluator keeps it going until
 *   the condition is met. `/goal clear` removes it. There is no native pause.
 *
 * There is no platform goal engine: the gateway never starts continuation turns or judges the condition.
 */

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked" // the harness reports it cannot progress
  | "budget_limited" // native budget exhausted (Codex tokenBudget)
  | "usage_limited" // provider usage limits
  | "achieved"
  | "cancelled";

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
export function goalStatusFromHarness(
  provider: "codex" | "claude",
  nativeStatus: string,
  cleared: boolean,
  current: GoalStatus | undefined,
): GoalStatus {
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

/**
 * Status after a goal command failed on the worker: what the harness last reported (the user's decision did not
 * reach it). A goal the harness never confirmed does not exist there: blocked, until the user resumes (the
 * objective is sent again) or clears it.
 */
export function goalStatusAfterFailure(provider: "codex" | "claude", nativeStatus: string): GoalStatus {
  return nativeStatus ? goalStatusFromHarness(provider, nativeStatus, false, undefined) : "blocked";
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
