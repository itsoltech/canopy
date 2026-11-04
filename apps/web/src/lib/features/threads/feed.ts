import type { ui } from "@canopy/contracts";
import type { TimelineEntry, TimelineNotice, TurnResult } from "./thread-state.svelte.ts";
import { buildTimeline, type ItemNode, type TimelineRow } from "./timeline.ts";
import { foldTurns, type WorkSummary } from "./work-groups.ts";

/**
 * The rows of the thread page's virtual feed, in order: a fork's inherited history (a header that folds
 * it, then per source thread an optional label and its rows, then the "Forked from" line), the thread's
 * own timeline, the working indicator and messages on their way into the running turn (steers). Queued
 * inputs are not rows: the queue panel above the composer shows and manages them (QueuePanel). An ended
 * turn's work is folded under one stable live/ended header (`work`, see work-groups.ts), in history too.
 */
export type FeedRow =
  | {
      readonly kind: "history-head";
      readonly key: string;
      readonly sourceId: string;
      readonly threadIds: readonly string[];
      readonly turns: number;
      readonly open: boolean;
    }
  | { readonly kind: "history-part"; readonly key: string; readonly threadId: string }
  /** `history`: inside the folded history (`last`: its last row). `work`: under an open "Worked for …" fold. */
  | {
      readonly kind: "timeline";
      readonly key: string;
      readonly row: TimelineRow;
      readonly history: boolean;
      readonly last: boolean;
      readonly work: boolean;
    }
  /** Stable fold, flattened tool group or streaming answer slot. */
  | (Extract<import("./work-groups.ts").FoldedRow, { kind: "work" | "work-group" | "answer" }> & {
      readonly history: boolean;
      readonly last: boolean;
    })
  | { readonly kind: "forked"; readonly key: string; readonly sourceId: string }
  | { readonly kind: "working"; readonly key: string }
  | { readonly kind: "steer"; readonly key: string; readonly steer: ui.Steer };

export interface FeedInput {
  readonly entries: readonly TimelineEntry[];
  readonly turns: readonly ui.Turn[];
  readonly notices: readonly TimelineNotice[];
  readonly results: ReadonlyMap<string, TurnResult>;
  /** Steers not yet in the transcript (pending or accepted). */
  readonly steering: readonly ui.Steer[];
  readonly working: boolean;
  /** A fork: the thread it was forked from, and the history it inherited. */
  readonly forkSourceId?: string | undefined;
  readonly inheritedEntries: readonly TimelineEntry[];
  readonly inheritedTurns: readonly ui.Turn[];
  readonly historyOpen: boolean;
  /** Turns whose work the reader opened (by turn id), live or ended. */
  readonly openWork: ReadonlySet<string>;
  readonly openGroups?: ReadonlySet<string>;
}

/** Group of a row for size estimates: items by their content, other rows by kind. */
export const feedGroup = (row: FeedRow): string =>
  row.kind === "timeline"
    ? (row.row.kind === "item" ? `item:${row.row.node.entry.item.content.case ?? ""}` : row.row.kind) +
      (row.history ? ":history" : "")
    : row.kind;

/**
 * How a row inserted mid-feed enters (VirtualFeed `inserted`): the rows of a fold that opened unfold,
 * a fold that formed when its turn ended resolves in. History rows opening with their header do not.
 */
export const feedInserted = (row: FeedRow): "unfold" | "reveal" | undefined =>
  row.kind === "work" && !row.history
    ? "reveal"
    : row.kind === "timeline" && row.work && !row.history
      ? "unfold"
      : undefined;

const ESTIMATES = new Map<string, number>([
  ["history-head", 56],
  ["history-part", 36],
  ["forked", 32],
  ["working", 36],
  ["steer", 96],
  ["turn-start", 24],
  ["input", 96],
  ["notice", 44],
  ["turn-end", 40],
  ["work", 36],
  ["work-group", 44],
  ["answer", 160],
  ["item:userMessage", 96],
  ["item:agentMessage", 160],
  ["item:subagent", 44],
]);

/** First guess of a group's height (px) until one of its rows is measured. */
export const feedEstimate = (group: string): number => ESTIMATES.get(group.replace(/:history$/, "")) ?? 44;

/**
 * Builds the feed, reusing the previous row objects (and item nodes) that did not change, so a streaming
 * delta re-renders only the row it touches.
 */
export class FeedBuilder {
  #rows = new Map<string, FeedRow>();
  readonly #nodes = new WeakMap<TimelineEntry, ItemNode>();

  build(input: FeedInput): FeedRow[] {
    const next: FeedRow[] = [];
    const open = (turnId: string) => input.openWork.has(turnId);
    const groupOpen = (key: string) => input.openGroups?.has(key) ?? false;
    const sourceId = input.forkSourceId;

    if (sourceId && input.inheritedTurns.length > 0) {
      const parts = historyParts(sourceId, input.inheritedEntries, input.inheritedTurns, input.results, this.#nodes);
      next.push({
        kind: "history-head",
        key: "history",
        sourceId,
        threadIds: parts.map((p) => p.threadId),
        turns: input.inheritedTurns.length,
        open: input.historyOpen,
      });

      if (input.historyOpen) {
        parts.forEach((part, p) => {
          if (parts.length > 1)
            next.push({ kind: "history-part", key: `history:${part.threadId}`, threadId: part.threadId });
          const folded = foldTurns(part.rows, open, groupOpen);
          folded.forEach((fold, r) => {
            const last = p === parts.length - 1 && r === folded.length - 1;

            if (fold.kind !== "row")
              next.push({ ...fold, key: `history:${part.threadId}:${fold.key}`, history: true, last });
            else
              next.push({
                kind: "timeline",
                key: `history:${part.threadId}:${fold.row.key}`,
                row: fold.row,
                history: true,
                last,
                work: fold.work,
              });
          });
        });
      }

      next.push({ kind: "forked", key: "forked", sourceId });
    }

    for (const fold of foldTurns(
      buildTimeline(input.entries, input.turns, input.notices, input.results, this.#nodes),
      open,
      groupOpen,
    )) {
      if (fold.kind !== "row") next.push({ ...fold, history: false, last: false });
      else
        next.push({ kind: "timeline", key: fold.row.key, row: fold.row, history: false, last: false, work: fold.work });
    }

    if (input.working && !next.some((r) => r.kind === "work" && r.summary.live))
      next.push({ kind: "working", key: "working" });

    for (const steer of input.steering) next.push({ kind: "steer", key: `steer:${steer.id}`, steer });

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
  const order = [
    ...new Set([...turns.map((t) => t.fromThreadId || sourceId), ...entries.map((e) => e.fromThreadId || sourceId)]),
  ];

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
  if (!shallowEqual(a, b, ["row", "threadIds", "summary", "items"])) return false;

  if (a.kind === "timeline" && b.kind === "timeline") return shallowEqual(a.row, b.row);

  if (a.kind === "answer" && b.kind === "answer")
    return a.row === undefined || b.row === undefined ? a.row === b.row : shallowEqual(a.row, b.row);

  if (a.kind === "work-group" && b.kind === "work-group")
    return a.items.length === b.items.length && a.items.every((key, i) => key === b.items[i]);

  if (a.kind === "work" && b.kind === "work") return shallowEqual(a.summary, b.summary);

  if (a.kind === "history-head" && b.kind === "history-head")
    return a.threadIds.length === b.threadIds.length && a.threadIds.every((id, i) => id === b.threadIds[i]);

  return true;
}

function shallowEqual<T extends FeedRow | TimelineRow | WorkSummary>(
  a: T,
  b: T,
  skip: readonly string[] = [],
): boolean {
  const left = Object.entries(a);
  const right = new Map(Object.entries(b));

  if (left.length !== right.size) return false;

  return left.every(([key, value]) => skip.includes(key) || value === right.get(key));
}
