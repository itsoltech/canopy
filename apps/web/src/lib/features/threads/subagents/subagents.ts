import type { ui } from "@canopy/contracts";
import { isActiveSubagent, subagentState, type SubagentState } from "@canopy/domain/subagents";

export { isActiveSubagent, subagentLook, subagentState, type SubagentState } from "@canopy/domain/subagents";

/**
 * The subagents of a thread (docs/agent-bus.md): side threads its agent started with spawn_thread, on any
 * provider, as the panel above the composer sums them up. From the live thread index, so it follows them.
 */
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
