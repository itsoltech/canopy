import type { ui } from "@canopy/contracts";

export type SubagentState = "working" | "waiting" | "completed" | "failed" | "interrupted";

/** Terminal threads cannot be revived by a stale pending-interaction count. */
export function isActiveSubagent(thread: ui.Thread): boolean {
  if (!["creating", "running", "waiting_input", "idle"].includes(thread.status)) return false;

  return thread.status !== "idle" || thread.pendingInteractions > 0;
}

/** Live work first, then the last turn's outcome, including after the thread is archived. */
export function subagentState(thread: ui.Thread): SubagentState {
  if (isActiveSubagent(thread))
    return thread.pendingInteractions > 0 || thread.status === "waiting_input" ? "waiting" : "working";

  if (thread.status === "failed") return "failed";

  switch (thread.lastTurnStatus) {
    case "completed":
    case "failed":
    case "interrupted":
      return thread.lastTurnStatus;
  }

  return thread.status === "interrupted" ? "interrupted" : "completed";
}
