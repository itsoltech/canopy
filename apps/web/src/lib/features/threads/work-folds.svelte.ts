import type { ui } from "@canopy/contracts";
import type { FeedRow } from "./feed.ts";
import type { TimelineEntry, TimelineNotice } from "./thread-state.svelte.ts";
import { isTerminal } from "./timeline.ts";
import { readWork } from "./work-groups.ts";
import { workFoldOpen, type WorkFoldPreferences } from "./work-fold-state.ts";

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

  toggle(turnId: string, open = !this.open.has(turnId)): void {
    this.#manual.set(turnId, open);

    if (open === this.open.has(turnId)) return;
    const next = new Set(this.open);

    if (open) next.add(turnId);
    else next.delete(turnId);
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
    const answers = new Map<string, boolean>();

    // Only the explicit phase is reliable before completion. Claude and Grok can resume tools after
    // any unphased message; their provisional answer slot must not trigger an early collapse.
    for (const entry of entries) {
      if (entry.item.parentItemId) continue;
      const content = entry.item.content;

      if (content.case === "agentMessage" && !content.value.text.trim()) continue;

      if (content.case === "reasoning" && !content.value.text.trim() && !content.value.summary.trim()) continue;
      answers.set(entry.turnId, content.case === "agentMessage" && content.value.phase === "final_answer");
    }

    const next = new Set<string>();
    const closing: string[] = [];

    for (const turn of turns) {
      const live = !isTerminal(turn.status);

      if (live) this.#running.add(turn.id);
      else if (this.#running.delete(turn.id)) ended.push(turn.id);

      if (
        workFoldOpen(
          live,
          answers.get(turn.id) ?? false,
          preferences,
          this.#manual.get(turn.id),
          this.#held.has(turn.id),
        )
      )
        next.add(turn.id);
      else if (this.open.has(turn.id)) closing.push(turn.id);
    }

    if (reader)
      for (const [turnId, key] of readWork(closing, reader.reading(), entries, notices)) {
        if (this.#manual.get(turnId) === false) continue;
        reader.hold(key);
        this.#held.add(turnId);
        next.add(turnId);
      }

    if (next.size !== this.open.size || [...next].some((id) => !this.open.has(id))) {
      this.open = next;
    }

    // VirtualFeed only moves a reader still following the end, and only for an oversized answer.
    for (const turnId of ended) void reader?.scrollRowToTop(`answer:${turnId}`);
  }
}
