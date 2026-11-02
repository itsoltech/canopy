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

/** Fixed-height output rows: only the viewport and its overscan enter the DOM. */
export const OUTPUT_LINE_HEIGHT = 20;
export function outputRange(count: number, top: number, height: number): [number, number] {
  const start = Math.max(0, Math.floor(Math.max(0, top) / OUTPUT_LINE_HEIGHT) - 8);
  return [Math.min(count, start), Math.min(count, Math.ceil((Math.max(0, top) + height) / OUTPUT_LINE_HEIGHT) + 8)];
}

/** Scroll events compare position, not the growing scrollHeight: arriving output cannot release the pin. */
export class OutputPin {
  pinned = true;
  top = 0;

  scroll(top: number, height: number, total: number): void {
    if (top < this.top - 1) this.pinned = false;
    else if (total - top - height <= 4) this.pinned = true;
    this.top = top;
  }

  latest(height: number, total: number): number {
    this.pinned = true;
    return (this.top = Math.max(0, total - height));
  }
}
