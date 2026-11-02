import { ItemStatus, type BackgroundTask } from "@open-agents/contracts";
import type { TimelineEntry } from "./thread-state.svelte.ts";

export type BackgroundEntry = TimelineEntry & { readonly item: TimelineEntry["item"] & { content: { case: "backgroundTask"; value: BackgroundTask } } };

/** All of this thread's background work, including items first reported between turns. */
export function backgroundTasks(entries: readonly TimelineEntry[]): BackgroundEntry[] {
  return entries
    .filter((entry): entry is BackgroundEntry => !entry.inherited && entry.item.content.case === "backgroundTask")
    .sort((a, b) => Number(b.item.status === ItemStatus.IN_PROGRESS) - Number(a.item.status === ItemStatus.IN_PROGRESS) || (a.firstSeq === b.firstSeq ? a.id.localeCompare(b.id) : a.firstSeq > b.firstSeq ? -1 : 1));
}

export function visibleTasks(tasks: readonly BackgroundEntry[], expanded: boolean, recent = 3): readonly BackgroundEntry[] {
  if (expanded) return tasks;
  let finished = 0;
  return tasks.filter((entry) => entry.item.status === ItemStatus.IN_PROGRESS || finished++ < recent);
}

export const backgroundName = (task: BackgroundTask): string => (task.description || task.command || task.taskId).split("\n")[0] ?? task.taskId;

export function backgroundStatus(entry: BackgroundEntry, exitCode?: number): string {
  const reason = entry.item.content.value.stopReason;
  if (entry.item.status === ItemStatus.IN_PROGRESS) return "Running";
  if (reason === "stopped_by_user") return "Stopped by you";
  if (entry.item.status === ItemStatus.INTERRUPTED || (reason && reason !== "error")) return "Stopped by system";
  if (entry.item.status === ItemStatus.FAILED || reason === "error") return `Failed${exitCode === undefined ? "" : ` · exit ${exitCode}`}`;
  if (entry.item.status === ItemStatus.COMPLETED) return exitCode === undefined ? "Done · exit unavailable" : `Done · exit ${exitCode}`;
  return "Pending";
}

export { OUTPUT_LINE_HEIGHT, outputRange, OutputPin } from "#lib/shared/ui/terminal-scroll.ts";
