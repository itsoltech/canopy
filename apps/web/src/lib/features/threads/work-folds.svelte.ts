import type { ui } from "@canopy/contracts";
import type { FeedRow } from "./feed.ts";
import type { TimelineEntry, TimelineNotice } from "./thread-state.svelte.ts";
import { isTerminal } from "./timeline.ts";
import { planFolds, readWork, type FoldsPlan } from "./work-segments.ts";
import { workFoldOpen, type WorkFoldPreferences } from "@canopy/domain/work-fold";

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
  readonly #manual = new Map<string, boolean>();
  readonly #manualGroups = new Set<string>();
  readonly #held = new Set<string>();
  #plan: FoldsPlan | undefined;

  /** Open or close a fold (a segment's, `foldId`): the reader's choice wins for the rest of the visit. */
  toggle(fold: string, open = !this.open.has(fold)): void {
    this.#manual.set(fold, open);

    if (open === this.open.has(fold)) return;
    const next = new Set(this.open);

    if (open) next.add(fold);
    else next.delete(fold);
    this.open = next;
  }

  toggleGroup(key: string, open = !this.groups.has(key)): void {
    this.#manualGroups.add(key);
    this.#setGroup(key, open);
  }

  #setGroup(key: string, open: boolean): void {
    if (open === this.groups.has(key)) return;
    const next = new Set(this.groups);

    if (open) next.add(key);
    else next.delete(key);
    this.groups = next;
  }

  /**
   * Reveal a live fold's groups unless manually closed. Remember its sole flattened group too, so
   * adding another group cannot hide rows the reader was seeing. Call outside tracking.
   */
  keepFlat(rows: readonly FeedRow[]): void {
    for (const row of rows) {
      const key =
        row.kind === "work" && row.open && row.summary.live
          ? row.flat
          : row.kind === "work-group" && !isTerminal(row.turn.status)
            ? row.key
            : undefined;

      if (key && !this.#manualGroups.has(key)) this.#setGroup(key, true);
    }
  }

  /** The thread's turns changed: call before the feed renders (`$effect.pre`), outside tracking. */
  update(
    turns: readonly ui.Turn[],
    entries: readonly TimelineEntry[],
    notices: readonly TimelineNotice[],
    reader: FoldReader | undefined,
    preferences: WorkFoldPreferences,
  ): void {
    const ended: string[] = [];

    for (const turn of turns) {
      if (!isTerminal(turn.status)) this.#running.add(turn.id);
      else if (this.#running.delete(turn.id)) ended.push(turn.id);
    }

    // Each segment of a turn folds as a turn would (docs/timeline-folding.md). Only an explicit phase marks
    // an answer before completion (Codex, and Claude once a message ends its turn): tools can resume after
    // any unphased message, and a provisional answer slot must not trigger an early collapse.
    const plan = planFolds(turns, entries, notices);
    this.#plan = plan;
    const next = new Set<string>();
    const closing: string[] = [];

    for (const fold of plan.folds) {
      if (workFoldOpen(fold.live, fold.answered, preferences, this.#manual.get(fold.id), this.#held.has(fold.id)))
        next.add(fold.id);
      else if (this.open.has(fold.id)) closing.push(fold.id);
    }

    if (reader)
      for (const [fold, key] of readWork(closing, reader.reading(), plan.workOf)) {
        if (this.#manual.get(fold) === false) continue;
        reader.hold(key);
        this.#held.add(fold);
        next.add(fold);
      }

    if (next.size !== this.open.size || [...next].some((id) => !this.open.has(id))) {
      this.open = next;
    }

    // VirtualFeed only moves a reader still following the end, and only for an oversized answer.
    for (const turnId of ended) void reader?.scrollRowToTop(`answer:${plan.last.get(turnId) ?? turnId}`);
  }

  /** The fold an item of the timeline sits under (by item id), if any: a quote opens it to show its source. */
  foldOf(itemId: string): string | undefined {
    return this.#plan?.workOf.get(`item:${itemId}`);
  }
}
