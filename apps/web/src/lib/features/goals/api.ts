import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";
import type { GoalAction } from "./goals.ts";

/**
 * Sets, pauses, resumes or clears the thread's harness goal (SetGoal). The gateway stores the decision at
 * once and returns the goal; the harness confirms it later (`native_status`, live in `ThreadUpdate.goal`).
 * `tokenBudget` (Codex only): 0 = no limit.
 */
export async function setGoal(
  threadId: string,
  action: GoalAction,
  set: { objective?: string; tokenBudget?: number } = {},
): Promise<ui.Goal | undefined> {
  const body = await requestJson("POST", `/api/threads/${encodeURIComponent(threadId)}/goal`, { action, ...set });

  return decode(ui.SetGoalResponseSchema, body).goal;
}
