import { timestampMs } from "@bufbuild/protobuf/wkt";
import { ItemStatus } from "@canopy/contracts";
import type { ui } from "@canopy/contracts";
import type { TimelineEntry } from "./thread-types.ts";
import type { ItemNode, TimelineRow } from "./timeline.ts";
import { currentWorkHint, groupSummary, isToolItem, workCounts } from "@canopy/domain/work-summary";
import type { IconName } from "@canopy/ui/icons";
import { blank } from "./work-segments.ts";
import { foldId, turnProgress, workSegments, type BodyRow, type WorkSegment } from "@canopy/domain/work-fold";
import { recoverFoldRows } from "./work-history.ts";
import { isReplyResult } from "./reply-items.ts";

/**
 * Each turn's work under a stable "Working for …" / "Worked for …" row:
 * the turn's start, its input, the fold, its final agent message and its footer stay; everything else
 * the turn did — tool and command items, reasoning, intermediate messages, background
 * tasks, notices — sits under the fold (`work`), shown after it only while it is open.
 *
 * - A running turn keeps commentary in its work. An unmarked latest message stays outside only while
 *   the fold is open, until more work arrives; a collapsed fold keeps it until it is marked final or the
 *   turn ends (`answerIndex`). The stable answer slot can shrink without removing a virtual row.
 * - The final message is the turn's last agent message. A turn that did not complete (interrupted,
 *   failed) keeps it only when nothing came after it; otherwise its footer (status, reason, Continue)
 *   is the end the reader sees.
 * - Even message-only turns retain the header and the answer slot at completion.
 * - A message marked final that more work follows stays shown: the work after it forms the turn's next
 *   segment (`workSegments`). Every steer also starts a segment, above its fold and answer slot (`fold`: the
 *   segment's fold id, `foldId`).
 * - Empty reasoning and messages add no visible work. Later text deltas can make them visible.
 * - Other turns and background work without a turn keep their own order.
 * - Consecutive tools always form a group under a stable header, including a sole group. Adding a
 *   second group cannot reparent existing tools or change the first group's manual choice.
 */
export type FoldedRow =
  | { readonly kind: "work-gap"; readonly key: string; readonly turn: ui.Turn }
  | {
      readonly kind: "row";
      readonly row: TimelineRow;
      readonly work: boolean;
      /** Surface fragment of an expanded tool group; rows remain independently virtualized. */
      readonly group?: "body" | "end";
    }
  | {
      readonly kind: "work";
      readonly key: string;
      readonly fold: string;
      readonly turn: ui.Turn;
      readonly open: boolean;
      readonly summary: WorkSummary;
    }
  | {
      readonly kind: "work-group";
      readonly key: string;
      readonly turn: ui.Turn;
      readonly open: boolean;
      readonly label: string;
      readonly running: boolean;
      readonly hint: string;
      readonly icon: IconName;
      readonly status: ItemStatus;
      readonly statusCount: number;
      readonly items: readonly string[];
    }
  | {
      readonly kind: "answer";
      readonly key: string;
      readonly fold: string;
      readonly turn: ui.Turn;
      readonly row: TimelineRow | undefined;
    };

export interface WorkSummary {
  /** The segment's start (the turn's, or its previous answer's end), ms; a live fold counts from it. */
  readonly startMs: number | undefined;
  /** Segment start to end (the turn's end, or its answer's), ms; undefined without both timestamps. */
  readonly spanMs: number | undefined;
  /** What the fold holds, e.g. "3 commands, 1 edit" (the most telling kinds, at most three). */
  readonly counts: string;
  /** Items still in progress under the fold (background tasks keep running after the turn). */
  readonly running: number;
  readonly live: boolean;
  readonly hint: string;
  /** Rows under the fold; an ended turn with none has nothing to unfold. */
  readonly size: number;
}

export function turnIdOf(row: TimelineRow): string {
  switch (row.kind) {
    case "item":
      return row.node.entry.turnId;
    case "notice":
      return row.notice.turnId;
    default:
      return row.turn.id;
  }
}

/** Rows of the turn that are its work or its final message (not its frame or input). */
const isBody = (row: TimelineRow): boolean => (row.kind === "item" && !row.inputOf) || row.kind === "notice";

const bodyRow = (row: TimelineRow): BodyRow => {
  const content = row.kind === "item" ? row.node.entry.item.content : undefined;

  return {
    phase: content?.case === "agentMessage" ? content.value.phase : undefined,
    steer: row.kind === "item" && row.steer,
  };
};

/** An item with nothing to show, without children. */
export const isEmpty = (row: TimelineRow): boolean =>
  row.kind === "item" && row.node.children.length === 0 && blank(row.node.entry.item.content);

interface SegmentTimes {
  readonly startMs: number | undefined;
  readonly endMs: number | undefined;
  readonly live: boolean;
}

interface TurnFold {
  readonly turn: ui.Turn;
  readonly body: readonly TimelineRow[];
  readonly segments: readonly WorkSegment[];
}

export function foldTurns(
  rows: readonly TimelineRow[],
  isOpen: (fold: string) => boolean,
  groupOpen: (key: string) => boolean = () => false,
  gaps: ReadonlySet<string> = new Set(),
  report: (count: number) => void = (count) => console.warn("Timeline recovery", { reason: "fold_derivation", count }),
): FoldedRow[] {
  // A background task owns its source command's lifecycle after the turn ends. System stops can
  // finish the task without another source-item update; tasks can also arrive outside the turn.
  const tasksBySource = new Map<string, TimelineEntry>();

  const indexTasks = (node: ItemNode) => {
    const content = node.entry.item.content;

    if (content.case === "backgroundTask" && content.value.sourceItemId)
      tasksBySource.set(content.value.sourceItemId, node.entry);
    node.children.forEach(indexTasks);
  };

  for (const row of rows) if (row.kind === "item") indexTasks(row.node);
  const turns = new Map<string, ui.Turn>();
  const ends = new Map<string, TimelineRow>();

  for (const row of rows) {
    if (row.kind === "turn-start" || row.kind === "turn-end") turns.set(row.turn.id, row.turn);

    if (row.kind === "turn-end") ends.set(row.turn.id, row);
  }

  const inputs = new Set(
    rows.flatMap((r) => (r.kind === "input" || (r.kind === "item" && r.inputOf) ? [turnIdOf(r)] : [])),
  );

  const bodies = new Map<string, TimelineRow[]>();
  const results = new Map<string, TimelineRow[]>();

  for (const row of rows) {
    const turnId = turnIdOf(row);

    if (row.kind === "item" && isReplyResult(row.node.entry.item.content)) {
      const list = results.get(turnId) ?? [];
      list.push(row);
      results.set(turnId, list);
      continue;
    }

    if (!turns.has(turnId) || !isBody(row) || isEmpty(row)) continue;
    const list = bodies.get(turnId);

    if (list) list.push(row);
    else bodies.set(turnId, [row]);
  }

  const folds = new Map<string, TurnFold>();

  for (const [turnId, turn] of turns) {
    const body = bodies.get(turnId) ?? [];
    const segments = workSegments(body.map(bodyRow), turnProgress(turn.status), (i) => isOpen(foldId(turnId, i)));
    folds.set(turnId, { turn, body, segments });
  }

  const out: FoldedRow[] = [];
  const placed = new Set<string>();

  for (const row of rows) {
    const turnId = turnIdOf(row);

    if (turns.has(turnId) && isBody(row) && isEmpty(row)) continue;
    const fold = folds.get(turnId);

    // Emit after the input, including a turn with no items yet. The next body/footer row is skipped.
    if (!fold || row.kind === "turn-start" || row.kind === "input" || (row.kind === "item" && row.inputOf)) {
      out.push({ kind: "row", row, work: false });

      if (!fold || (row.kind === "turn-start" && inputs.has(turnId))) continue;
    }

    if (placed.has(turnId)) continue;

    if (!fold) continue;
    placed.add(turnId);

    if (gaps.has(turnId)) {
      out.push({ kind: "work-gap", key: `work-gap:${turnId}`, turn: fold.turn });

      // No items have arrived for this turn. Its duration is not evidence of an empty work section.
      if (fold.body.length === 0) continue;
    }

    const derived = fold.segments.flatMap((_, index) => segmentRows(fold, index, isOpen, groupOpen, tasksBySource));
    out.push(...recoverFoldRows(fold.body, derived, report));

    for (const result of results.get(turnId) ?? []) out.push({ kind: "row", row: result, work: false });

    // The body is grouped here even when old items arrive after a newer turn. Its footer belongs here too.
    const end = ends.get(turnId);

    if (end) out.push({ kind: "row", row: end, work: false });
  }

  return out;
}

/** A segment's leading steers (as the conversation shows them), its fold, the open fold's rows and its answer slot. */
function segmentRows(
  fold: TurnFold,
  index: number,
  isOpen: (fold: string) => boolean,
  groupOpen: (key: string) => boolean,
  tasksBySource: ReadonlyMap<string, TimelineEntry>,
): FoldedRow[] {
  const { turn, body, segments } = fold;
  const segment = segments[index]!;
  const id = foldId(turn.id, index);
  const final = segment.answer >= 0 ? body[segment.answer] : undefined;
  const rows = body.slice(segment.start, segment.end);
  const work = rows.slice(segment.inputs).filter((row) => row !== final);
  const open = isOpen(id);
  const groups = toolGroups(work);
  const out: FoldedRow[] = rows.slice(0, segment.inputs).map((row) => ({ kind: "row", row, work: false }));
  out.push({
    kind: "work",
    key: `work:${id}`,
    fold: id,
    turn,
    open,
    summary: summarize(turn, work, tasksBySource, segmentTimes(fold, index)),
  });

  if (open) out.push(...workRows(turn, work, groups, groupOpen));
  out.push({ kind: "answer", key: `answer:${id}`, fold: id, turn, row: final });

  return out;
}

/** Steer boundaries have no durable item timestamp; omit their time instead of changing it on reload. */
function segmentTimes(fold: TurnFold, index: number): SegmentTimes {
  const { turn, body, segments } = fold;

  const answerEnd = (at: number | undefined) => {
    const row = at === undefined ? undefined : body[at];

    return row?.kind === "item" ? row.node.entry.completedAt : undefined;
  };

  const ms = (time: ui.Turn["startedAt"]) => (time ? timestampMs(time) : undefined);

  return {
    startMs:
      index === 0 ? ms(turn.startedAt) : segments[index]?.inputs ? undefined : answerEnd(segments[index - 1]?.answer),
    endMs: index === segments.length - 1 ? ms(turn.completedAt) : answerEnd(segments[index]?.answer),
    live: index === segments.length - 1 && (segments[index]?.live ?? false),
  };
}

const groupKey = (turnId: string, tools: readonly TimelineRow[]): string => `group:${turnId}:${tools[0]!.key}`;

/** Runs of consecutive tool rows, in order. */
function toolGroups(work: readonly TimelineRow[]): TimelineRow[][] {
  const groups: TimelineRow[][] = [];
  let run: TimelineRow[] | undefined;

  for (const row of work) {
    if (!isToolRow(row)) run = undefined;
    else if (run) run.push(row);
    else groups.push((run = [row]));
  }

  return groups;
}

/** An open fold's rows: other work as it is, tools under their stable group header. */
function workRows(
  turn: ui.Turn,
  work: readonly TimelineRow[],
  groups: readonly TimelineRow[][],
  groupOpen: (key: string) => boolean,
): FoldedRow[] {
  const out: FoldedRow[] = [];
  const groupOf = new Map(groups.flatMap((tools) => tools.map((row) => [row, tools] as const)));

  for (const row of work) {
    const tools = groupOf.get(row);

    if (!tools) {
      out.push({ kind: "row", row, work: true });
      continue;
    }

    const key = groupKey(turn.id, tools);
    const open = groupOpen(key);

    if (row === tools[0])
      out.push({
        kind: "work-group",
        key,
        turn,
        open,
        ...groupSummary(itemsOf(tools)),
        running: tools.some((r) => r.kind === "item" && r.node.entry.item.status === ItemStatus.IN_PROGRESS),
        hint: currentWorkHint(itemsOf(tools)),
        items: tools.map((r) => r.key),
      });

    if (open) out.push({ kind: "row", row, work: true, group: row === tools.at(-1) ? "end" : "body" });
  }

  return out;
}

function summarize(
  turn: ui.Turn,
  work: readonly TimelineRow[],
  tasksBySource: ReadonlyMap<string, TimelineEntry>,
  { startMs, endMs, live }: SegmentTimes,
): WorkSummary {
  const running = new Set<string>();

  const visit = (node: ItemNode) => {
    const entry = tasksBySource.get(node.entry.id) ?? node.entry;

    if (entry.item.status === ItemStatus.IN_PROGRESS) running.add(entry.id);
    node.children.forEach(visit);
  };

  for (const row of work) if (row.kind === "item") visit(row.node);

  const spanMs = startMs !== undefined && endMs !== undefined ? endMs - startMs : undefined;

  return {
    startMs,
    spanMs: spanMs !== undefined && spanMs >= 0 ? spanMs : undefined,
    counts: workCounts(itemsOf(work)),
    running: running.size,
    live,
    hint: currentWorkHint(
      itemsOf(work),
      (item) => (tasksBySource.get(item.itemId)?.item ?? item).status === ItemStatus.IN_PROGRESS,
    ),
    size: work.length,
  };
}

const isToolRow = (row: TimelineRow): boolean => row.kind === "item" && isToolItem(row.node.entry.item);

const itemsOf = (rows: readonly TimelineRow[]) => rows.flatMap((r) => (r.kind === "item" ? [r.node.entry.item] : []));
