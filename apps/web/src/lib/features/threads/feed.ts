import type { ui } from "@open-agents/contracts";
import type { TimelineEntry, TimelineNotice, TurnResult } from "./thread-state.svelte.ts";
import { buildTimeline, type ItemNode, type TimelineRow } from "./timeline.ts";

/**
 * The rows of the thread page's virtual feed, in order: a fork's inherited history (a header that folds
 * it, then per source thread an optional label and its rows, then the "Forked from" line), the thread's
 * own timeline, the working indicator, messages on their way into the running turn (steers) and queued
 * inputs (`fallback`: a steer that could not join its turn and runs next instead).
 */
export type FeedRow =
  | { readonly kind: "history-head"; readonly key: string; readonly sourceId: string; readonly threadIds: readonly string[]; readonly turns: number; readonly open: boolean }
  | { readonly kind: "history-part"; readonly key: string; readonly threadId: string }
  /** `history`: inside the folded history (`last`: its last row). */
  | { readonly kind: "timeline"; readonly key: string; readonly row: TimelineRow; readonly history: boolean; readonly last: boolean }
  | { readonly kind: "forked"; readonly key: string; readonly sourceId: string }
  | { readonly kind: "working"; readonly key: string }
  | { readonly kind: "steer"; readonly key: string; readonly steer: ui.Steer }
  | { readonly kind: "queued"; readonly key: string; readonly turn: ui.Turn; readonly fallback: ui.Steer | undefined };

export interface FeedInput {
  readonly entries: readonly TimelineEntry[];
  readonly turns: readonly ui.Turn[];
  readonly notices: readonly TimelineNotice[];
  readonly results: ReadonlyMap<string, TurnResult>;
  readonly queued: readonly ui.Turn[];
  /** Steers not yet in the transcript (pending or accepted). */
  readonly steering: readonly ui.Steer[];
  /** All of the thread's steers (a queued one names its turn). */
  readonly steers: readonly ui.Steer[];
  readonly working: boolean;
  /** A fork: the thread it was forked from, and the history it inherited. */
  readonly forkSourceId?: string | undefined;
  readonly inheritedEntries: readonly TimelineEntry[];
  readonly inheritedTurns: readonly ui.Turn[];
  readonly historyOpen: boolean;
}

/** Group of a row for size estimates: items by their content, other rows by kind. */
export const feedGroup = (row: FeedRow): string =>
  row.kind === "timeline" ? (row.row.kind === "item" ? `item:${row.row.node.entry.item.content.case ?? ""}` : row.row.kind) + (row.history ? ":history" : "") : row.kind;

const ESTIMATES: Record<string, number> = {
  "history-head": 56,
  "history-part": 36,
  forked: 32,
  working: 36,
  steer: 96,
  queued: 96,
  "turn-start": 36,
  input: 96,
  notice: 44,
  "turn-end": 40,
  "item:userMessage": 96,
  "item:agentMessage": 160,
  "item:subagent": 120,
};
/** First guess of a group's height (px) until one of its rows is measured. */
export const feedEstimate = (group: string): number => ESTIMATES[group.replace(/:history$/, "")] ?? 44;

/**
 * Builds the feed, reusing the previous row objects (and item nodes) that did not change, so a streaming
 * delta re-renders only the row it touches.
 */
export class FeedBuilder {
  #rows = new Map<string, FeedRow>();
  readonly #nodes = new WeakMap<TimelineEntry, ItemNode>();

  build(input: FeedInput): FeedRow[] {
    const next: FeedRow[] = [];
    const sourceId = input.forkSourceId;
    if (sourceId && input.inheritedTurns.length > 0) {
      const parts = historyParts(sourceId, input.inheritedEntries, input.inheritedTurns, input.results, this.#nodes);
      next.push({ kind: "history-head", key: "history", sourceId, threadIds: parts.map((p) => p.threadId), turns: input.inheritedTurns.length, open: input.historyOpen });
      if (input.historyOpen) {
        parts.forEach((part, p) => {
          if (parts.length > 1) next.push({ kind: "history-part", key: `history:${part.threadId}`, threadId: part.threadId });
          part.rows.forEach((row, r) =>
            next.push({ kind: "timeline", key: `history:${part.threadId}:${row.key}`, row, history: true, last: p === parts.length - 1 && r === part.rows.length - 1 }),
          );
        });
      }
      next.push({ kind: "forked", key: "forked", sourceId });
    }
    for (const row of buildTimeline(input.entries, input.turns, input.notices, input.results, this.#nodes)) next.push({ kind: "timeline", key: row.key, row, history: false, last: false });
    if (input.working) next.push({ kind: "working", key: "working" });
    for (const steer of input.steering) next.push({ kind: "steer", key: `steer:${steer.id}`, steer });
    const fallbacks = new Map(input.steers.filter((s) => s.queuedTurnId).map((s) => [s.queuedTurnId, s]));
    for (const turn of input.queued) next.push({ kind: "queued", key: `queued:${turn.id}`, turn, fallback: fallbacks.get(turn.id) });

    const previous = this.#rows;
    this.#rows = new Map();
    return next.map((row) => {
      const old = previous.get(row.key);
      const kept = old && sameRow(old, row) ? old : row;
      this.#rows.set(row.key, kept);
      return kept;
    });
  }
}

/** The inherited history per thread it came from (a fork of a fork inherits from several), oldest first. */
function historyParts(
  sourceId: string,
  entries: readonly TimelineEntry[],
  turns: readonly ui.Turn[],
  results: ReadonlyMap<string, TurnResult>,
  nodes: WeakMap<TimelineEntry, ItemNode>,
): { threadId: string; rows: TimelineRow[] }[] {
  const order = [...new Set([...turns.map((t) => t.fromThreadId || sourceId), ...entries.map((e) => e.fromThreadId || sourceId)])];
  return order.map((threadId) => ({
    threadId,
    rows: buildTimeline(
      entries.filter((e) => (e.fromThreadId || sourceId) === threadId),
      turns.filter((t) => (t.fromThreadId || sourceId) === threadId),
      [],
      results,
      nodes,
    ),
  }));
}

/** Same kind and the same values (by identity) one level down, including the timeline row's fields. */
function sameRow(a: FeedRow, b: FeedRow): boolean {
  if (!shallowEqual(a, b, ["row", "threadIds"])) return false;
  if (a.kind === "timeline" && b.kind === "timeline") return shallowEqual(a.row, b.row);
  if (a.kind === "history-head" && b.kind === "history-head") return a.threadIds.length === b.threadIds.length && a.threadIds.every((id, i) => id === b.threadIds[i]);
  return true;
}

function shallowEqual(a: object, b: object, skip: readonly string[] = []): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => skip.includes(key) || left[key] === right[key]);
}
