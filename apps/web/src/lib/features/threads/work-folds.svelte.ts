import type { ui } from "@canopy/contracts";
import type { TimelineEntry, TimelineNotice } from "./thread-state.svelte.ts";
import { isTerminal } from "./timeline.ts";
import { readWork } from "./work-groups.ts";

/** The feed as the folds need it (VirtualFeed's `reading` and `hold`). */
export interface FoldReader {
  reading(): string[];
  hold(key: string): void;
  scrollRowToTop(key: string): Promise<boolean>;
}

/**
 * Per-page choices for live/ended folds and tool groups, surviving virtual unmounts. Completion
 * preserves the reader's choices and holds any visible work row. Following readers start long final
 * answers at the top; VirtualFeed leaves short answers and readers who scrolled away alone.
 */
export class WorkFolds {
  open = $state.raw<ReadonlySet<string>>(new Set());
  groups = $state.raw<ReadonlySet<string>>(new Set());
  /** Turns seen running: their end is a change the reader may be in the middle of. */
  readonly #running = new Set<string>();

  toggle(turnId: string, open = !this.open.has(turnId)): void {
    if (open === this.open.has(turnId)) return;
    const next = new Set(this.open);
    if (open) next.add(turnId);
    else next.delete(turnId);
    this.open = next;
  }

  toggleGroup(key: string, open = !this.groups.has(key)): void {
    if (open === this.groups.has(key)) return;
    const next = new Set(this.groups);
    if (open) next.add(key);
    else next.delete(key);
    this.groups = next;
  }

  /** The thread's turns changed: call before the feed renders (`$effect.pre`), outside tracking. */
  update(turns: readonly ui.Turn[], entries: readonly TimelineEntry[], notices: readonly TimelineNotice[], reader: FoldReader | undefined): void {
    const ended: string[] = [];
    for (const turn of turns) {
      if (!isTerminal(turn.status)) this.#running.add(turn.id);
      else if (this.#running.delete(turn.id)) ended.push(turn.id);
    }
    if (ended.length === 0 || !reader) return;
    for (const [turnId, key] of readWork(ended, reader.reading(), entries, notices)) {
      reader.hold(key);
      this.toggle(turnId, true);
    }
    // VirtualFeed only moves a reader still following the end, and only for an oversized answer.
    for (const turnId of ended) void reader.scrollRowToTop(`answer:${turnId}`);
  }
}
