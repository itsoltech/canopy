import type { ui } from "@canopy/contracts";
import type { StatusLook } from "#lib/shared/ui/status.ts";
import { isActiveSubagent, subagentState, type SubagentState } from "@canopy/domain/subagents";

export { isActiveSubagent, subagentState, type SubagentState };

/**
 * The subagents of a thread (docs/agent-bus.md): side threads its agent started with spawn_thread, on any
 * provider, as the panel above the composer sums them up. From the live thread index, so it follows them.
 */
const looks: Record<SubagentState, StatusLook> = {
  working: { label: "Working", tone: "sky", active: true },
  waiting: { label: "Waiting for an answer", tone: "amber", active: true },
  completed: { label: "Completed", tone: "emerald" },
  failed: { label: "Failed", tone: "rose" },
  interrupted: { label: "Interrupted", tone: "orange" },
};

export const subagentLook = (state: SubagentState): StatusLook => looks[state];

export interface Subagent {
  readonly thread: ui.Thread;
  readonly state: SubagentState;
}

/** Only the thread's active subagents, newest first. Completed work stays in the timeline/lineage. */
export function subagentsOf(threads: Iterable<ui.Thread>, parentId: string): Subagent[] {
  return [...threads]
    .flatMap((thread) =>
      thread.parentThreadId === parentId && thread.spawnedByAgent && isActiveSubagent(thread)
        ? [{ thread, state: subagentState(thread) }]
        : [],
    )
    .sort((a, b) => Number((b.thread.createdAt?.seconds ?? 0n) - (a.thread.createdAt?.seconds ?? 0n)));
}

/** Active counts only: "2 subagents working · 1 needs you". Empty when no agent is active. */
export function subagentSummary(list: readonly Subagent[]): string {
  const active = list.filter((s) => isActiveSubagent(s.thread));
  const working = active.filter((s) => s.state === "working").length;
  const waiting = active.filter((s) => s.state === "waiting").length;
  const noun = (n: number) => (n === 1 ? "subagent" : "subagents");

  return [
    working ? `${working} ${noun(working)} working` : "",
    waiting ? `${waiting}${working ? "" : ` ${noun(waiting)}`} ${waiting === 1 ? "needs" : "need"} you` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
