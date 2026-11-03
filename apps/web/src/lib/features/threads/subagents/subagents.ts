import type { ui } from "@canopy/contracts";
import type { StatusLook } from "#lib/shared/ui/status.ts";

/**
 * The subagents of a thread (docs/agent-bus.md): side threads its agent started with spawn_thread, on any
 * provider, as the panel above the composer sums them up. From the live thread index, so it follows them.
 */
export type SubagentState = "working" | "waiting" | "completed" | "failed" | "interrupted";

const looks: Record<SubagentState, StatusLook> = {
  working: { label: "Working", tone: "sky", active: true },
  waiting: { label: "Waiting for an answer", tone: "amber", active: true },
  completed: { label: "Completed", tone: "emerald" },
  failed: { label: "Failed", tone: "rose" },
  interrupted: { label: "Interrupted", tone: "orange" },
};

export const subagentLook = (state: SubagentState): StatusLook => looks[state];

/** A question or permission prompt first; then a turn on its way; then how its last turn ended. */
export function subagentState(thread: ui.Thread): SubagentState {
  if (thread.pendingInteractions > 0 || thread.status === "waiting_input") return "waiting";
  if (thread.status === "creating" || thread.status === "running") return "working";
  if (thread.status === "failed") return "failed";
  switch (thread.lastTurnStatus) {
    case "completed":
    case "failed":
    case "interrupted":
      return thread.lastTurnStatus;
  }
  // Interrupted before any turn ended, or idle with its first turn about to start.
  return thread.status === "interrupted" ? "interrupted" : "working";
}

export interface Subagent {
  readonly thread: ui.Thread;
  readonly state: SubagentState;
}

/** Closed/failed/interrupted threads cannot be revived by a stale pending-interaction count.
 * Idle threads count only while they still need a person's answer or approval. */
export function isActiveSubagent(thread: ui.Thread): boolean {
  if (!["creating", "running", "waiting_input", "idle"].includes(thread.status)) return false;
  return thread.status !== "idle" || thread.pendingInteractions > 0;
}

/** Only the thread's active subagents, newest first. Completed work stays in the timeline/lineage. */
export function subagentsOf(threads: Iterable<ui.Thread>, parentId: string): Subagent[] {
  return [...threads]
    .filter((t) => t.parentThreadId === parentId && t.spawnedByAgent && isActiveSubagent(t))
    .map((thread) => ({ thread, state: subagentState(thread) }))
    .sort((a, b) => Number((b.thread.createdAt?.seconds ?? 0n) - (a.thread.createdAt?.seconds ?? 0n)));
}

/** Active counts only: "2 subagents working · 1 needs you". Empty when no agent is active. */
export function subagentSummary(list: readonly Subagent[]): string {
  const active = list.filter((s) => isActiveSubagent(s.thread));
  const working = active.filter((s) => s.state === "working").length;
  const waiting = active.filter((s) => s.state === "waiting").length;
  const noun = (n: number) => n === 1 ? "subagent" : "subagents";
  return [
    working ? `${working} ${noun(working)} working` : "",
    waiting ? `${waiting}${working ? "" : ` ${noun(waiting)}`} ${waiting === 1 ? "needs" : "need"} you` : "",
  ].filter(Boolean).join(" · ");
}
