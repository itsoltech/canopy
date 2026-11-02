import type { ui } from "@open-agents/contracts";
import type { TimelineEntry, TimelineNotice } from "./thread-state.svelte.ts";
import { isTerminal } from "./timeline.ts";
import { readWork } from "./work-groups.ts";

/** The feed as the folds need it (VirtualFeed's `reading` and `hold`). */
export interface FoldReader {
  reading(): string[];
  hold(key: string): void;
}

/**
 * Which ended turns of a thread have their "Worked for …" fold open. Kept per thread page, not in a
 * row, so it survives rows scrolling out of the virtual feed. A turn that ends folds, unless the reader
 * is in its work right now (scrolled up with one of its rows on screen, or focused in one): then it
 * stays open and the row being read keeps its place, so nothing moves under them. Reading only the
 * turn's input or last message (they stay), or anything above, it folds: the feed keeps those in place.
 */
export class WorkFolds {
  open = $state.raw<ReadonlySet<string>>(new Set());
  /** Turns seen running: their end is a change the reader may be in the middle of. */
  readonly #running = new Set<string>();

  toggle(turnId: string, open = !this.open.has(turnId)): void {
    if (open === this.open.has(turnId)) return;
    const next = new Set(this.open);
    if (open) next.add(turnId);
    else next.delete(turnId);
    this.open = next;
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
  }
}
