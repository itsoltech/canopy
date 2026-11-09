import type { ui, Item } from "@canopy/contracts";
import { foldId, turnProgress, workSegments, type BodyRow } from "@canopy/domain/work-fold";
import type { TimelineEntry, TimelineNotice } from "./thread-types.ts";
import { isSteerMessage } from "./timeline.ts";

/** A message or reasoning with nothing to show yet: it adds no visible work (later deltas can fill it). */
export function blank(content: Item["content"]): boolean {
  if (content.case === "reasoning") return !content.value.text.trim() && !content.value.summary.trim();

  if (content.case === "agentMessage") return !content.value.text.trim();

  return false;
}

/** One segment's fold as `WorkFolds` decides it: open or closed by the same rules as a turn's. */
export interface FoldPlan {
  readonly id: string;
  readonly turnId: string;
  readonly live: boolean;
  readonly answered: boolean;
}

export interface FoldsPlan {
  /** Every segment's fold of every turn, in order. */
  readonly folds: readonly FoldPlan[];
  /** Feed key of a row under a fold (`item:…`, `notice:…`) → that fold's id. */
  readonly workOf: ReadonlyMap<string, string>;
  /** A turn's last fold: its answer is the turn's answer. */
  readonly last: ReadonlyMap<string, string>;
}

/**
 * The turns' segments from their entries and notices: the same body as `foldTurns` reads (top-level items
 * other than the input, without empty ones, and notices, by seq), without building the timeline.
 */
export function planFolds(
  turns: readonly ui.Turn[],
  entries: readonly TimelineEntry[],
  notices: readonly TimelineNotice[],
): FoldsPlan {
  const ids = new Set(entries.map((e) => e.id));
  const parents = new Set(entries.map((e) => e.item.parentItemId));
  const bodies = new Map<string, { key: string; seq: bigint; row: BodyRow }[]>();

  const add = (turnId: string, key: string, seq: bigint, row: BodyRow) => {
    const list = bodies.get(turnId);

    if (list) list.push({ key, seq, row });
    else bodies.set(turnId, [{ key, seq, row }]);
  };

  for (const entry of entries) {
    const { content, parentItemId } = entry.item;
    const steer = isSteerMessage(entry);

    if (parentItemId && parentItemId !== entry.id && ids.has(parentItemId)) continue;

    if ((content.case === "userMessage" && !steer) || (!parents.has(entry.id) && blank(content))) continue;
    add(entry.turnId, `item:${entry.id}`, entry.firstSeq, {
      phase: content.case === "agentMessage" ? content.value.phase : undefined,
      steer,
    });
  }

  for (const notice of notices)
    add(notice.turnId, `notice:${notice.seq}`, notice.seq, { phase: undefined, steer: false });
  const folds: FoldPlan[] = [];
  const workOf = new Map<string, string>();
  const last = new Map<string, string>();

  for (const turn of turns) {
    const body = (bodies.get(turn.id) ?? []).sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

    const segments = workSegments(
      body.map((b) => b.row),
      turnProgress(turn.status),
      () => false,
    );

    segments.forEach((segment, index) => {
      const id = foldId(turn.id, index);
      folds.push({ id, turnId: turn.id, live: segment.live, answered: segment.answered });
      last.set(turn.id, id);

      for (let at = segment.start + segment.inputs; at < segment.end; at++)
        if (at !== segment.answer) workOf.set(body[at]!.key, id);
    });
  }

  return { folds, workOf, last };
}

/**
 * Of the folds about to close, the ones the reader is in: one of their work rows (not the inputs or the
 * answer around them — those stay) among `reading` (row keys on screen or focused, in order). For each,
 * the first such row: it keeps its place when the fold closes above it.
 */
export function readWork(
  closing: readonly string[],
  reading: readonly string[],
  workOf: ReadonlyMap<string, string>,
): Map<string, string> {
  const held = new Map<string, string>();

  for (const key of reading) {
    const fold = workOf.get(key);

    if (fold && closing.includes(fold) && !held.has(fold)) held.set(fold, key);
  }

  return held;
}
