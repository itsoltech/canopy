import type { ui } from "@open-agents/contracts";
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

/** The thread's subagents, the ones still at work first, then the newest. */
export function subagentsOf(threads: Iterable<ui.Thread>, parentId: string): Subagent[] {
  const busy = (s: SubagentState) => (s === "working" || s === "waiting" ? 0 : 1);
  return [...threads]
    .filter((t) => t.parentThreadId === parentId && t.spawnedByAgent)
    .map((thread) => ({ thread, state: subagentState(thread) }))
    .sort((a, b) => busy(a.state) - busy(b.state) || Number((b.thread.createdAt?.seconds ?? 0n) - (a.thread.createdAt?.seconds ?? 0n)));
}

/** One line: "3 subagents · 2 running · 1 done", with the ones waiting, failed or interrupted when there are any. */
export function subagentSummary(list: readonly Subagent[]): string {
  const count = (state: SubagentState) => list.filter((s) => s.state === state).length;
  const parts = [
    [count("working"), "running"],
    [count("waiting"), "waiting"],
    [count("completed"), "done"],
    [count("failed"), "failed"],
    [count("interrupted"), "interrupted"],
  ] as const;
  return [`${list.length} ${list.length === 1 ? "subagent" : "subagents"}`, ...parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`)].join(" · ");
}
