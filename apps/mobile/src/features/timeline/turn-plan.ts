import { ItemStatus, type Item, type ui } from "@canopy/contracts";
import { turnProgress, workSegments, type WorkSegment } from "@canopy/domain/work-fold";
import { currentWorkHint, groupSummary, isToolItem, workCounts } from "@canopy/domain/work-summary";
import { itemNodes, type ItemNode } from "./item-nodes";

/** What a fold says about its work (web: work-groups.ts WorkSummary). */
export interface WorkSummary {
  readonly startMs: number | undefined;
  readonly spanMs: number | undefined;
  readonly counts: string;
  readonly running: number;
  readonly live: boolean;
  readonly hint: string;
  readonly size: number;
}

/** A row of a turn's body (web: TimelineRow item | notice): an item with its nested items, or a notice. */
export type BodyRow =
  | {
      readonly kind: "item";
      readonly key: string;
      readonly node: ItemNode;
      readonly steer: boolean;
      readonly completedAt: number | undefined;
    }
  | { readonly kind: "notice"; readonly key: string; readonly notice: ui.ThreadNotice };

/** What the open fold shows: rows as they are, or tools under a group header (web: workRows). */
export type WorkRow =
  | { readonly kind: "row"; readonly row: BodyRow }
  | {
      readonly kind: "group";
      readonly key: string;
      readonly label: string;
      readonly running: boolean;
      readonly rows: readonly BodyRow[];
    };

/** A message or reasoning with nothing to show yet adds no visible work (later deltas can fill it). */
function blank(item: Item): boolean {
  const content = item.content;

  if (content.case === "reasoning") return !content.value.text.trim() && !content.value.summary.trim();

  if (content.case === "agentMessage") return !content.value.text.trim();

  return false;
}

/** A user_message that joined a running turn: its `client_id` is a steer's id; the turn's own input has the turn's. */
export const isSteer = (item: Item, turnId: string): boolean =>
  item.content.case === "userMessage" && item.content.value.clientId !== "" && item.content.value.clientId !== turnId;

const ms = (time: { seconds: bigint; nanos: number } | undefined) =>
  time ? Number(time.seconds) * 1000 + Math.floor(time.nanos / 1e6) : undefined;

/**
 * The turn's body as the web folds it (web: buildTimeline + foldTurns): top-level items other than its input and
 * interaction cards, without empty ones, and its notices, by seq.
 */
export function turnBody(
  turn: ui.Turn,
  entries: readonly ui.TimelineItem[],
  notices: readonly ui.ThreadNotice[],
): BodyRow[] {
  const items = entries.flatMap((e) => (e.item ? [e.item] : []));
  const seq = new Map(entries.flatMap((e) => (e.item ? [[e.item.itemId, e.firstSeq] as const] : [])));
  const done = new Map(entries.flatMap((e) => (e.item ? [[e.item.itemId, ms(e.completedAt)] as const] : [])));

  const rows: (BodyRow & { seq: bigint })[] = itemNodes(items).flatMap((node) => {
    const { item } = node;
    const steer = isSteer(item, turn.id);

    if ((item.content.case === "userMessage" && !steer) || (!node.children.length && blank(item))) return [];

    return [
      {
        kind: "item" as const,
        key: `item:${item.itemId}`,
        node,
        steer,
        completedAt: done.get(item.itemId),
        seq: seq.get(item.itemId) ?? 0n,
      },
    ];
  });

  for (const notice of notices)
    if (notice.turnId === turn.id) rows.push({ kind: "notice", key: `notice:${notice.seq}`, notice, seq: notice.seq });

  return rows.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
}

const phaseOf = (row: BodyRow) =>
  row.kind === "item" && row.node.item.content.case === "agentMessage" ? row.node.item.content.value.phase : undefined;

export const segmentsOf = (
  turn: ui.Turn,
  body: readonly BodyRow[],
  open: (segment: number) => boolean,
): WorkSegment[] =>
  workSegments(
    body.map((row) => ({ phase: phaseOf(row), steer: row.kind === "item" && row.steer })),
    turnProgress(turn.status),
    open,
  );

const itemOf = (row: BodyRow) => (row.kind === "item" ? [row.node.item] : []);
const isToolRow = (row: BodyRow) => row.kind === "item" && isToolItem(row.node.item);

/** Runs of consecutive tools; a sole run shows without its header (it would repeat the fold's counts). */
export function workRows(work: readonly BodyRow[], groupOpen: (key: string) => boolean): WorkRow[] {
  const runs: BodyRow[][] = [];
  let run: BodyRow[] | undefined;

  for (const row of work)
    if (!isToolRow(row)) run = undefined;
    else if (run) run.push(row);
    else runs.push((run = [row]));

  if (runs.length <= 1) return work.map((row) => ({ kind: "row", row }));
  const first = new Map(runs.map((rows) => [rows[0], rows] as const));
  const out: WorkRow[] = [];

  for (const row of work) {
    const rows = first.get(row);

    if (rows) {
      const key = rows[0]!.key;
      out.push({
        kind: "group",
        key,
        label: groupSummary(rows.flatMap(itemOf)),
        running: rows.some((r) => r.kind === "item" && r.node.item.status === ItemStatus.IN_PROGRESS),
        rows: groupOpen(key) ? rows : [],
      });
    } else if (!isToolRow(row)) out.push({ kind: "row", row });
  }

  return out;
}

/** The fold's header (web: summarize). `tasks`: background tasks by the command that started them. */
export function summarize(
  work: readonly BodyRow[],
  times: { startMs: number | undefined; endMs: number | undefined; live: boolean },
  tasks: ReadonlyMap<string, Item>,
): WorkSummary {
  const items = work.flatMap(itemOf);
  const status = (item: Item) => (tasks.get(item.itemId) ?? item).status;
  const running = new Set<string>();

  const visit = (node: ItemNode) => {
    if (status(node.item) === ItemStatus.IN_PROGRESS) running.add(node.item.itemId);
    node.children.forEach(visit);
  };

  for (const row of work) if (row.kind === "item") visit(row.node);
  const span = times.startMs !== undefined && times.endMs !== undefined ? times.endMs - times.startMs : undefined;

  return {
    startMs: times.startMs,
    spanMs: span !== undefined && span >= 0 ? span : undefined,
    counts: workCounts(items),
    running: running.size,
    live: times.live,
    hint: currentWorkHint(items, (item) => status(item) === ItemStatus.IN_PROGRESS),
    size: work.length,
  };
}

export { ms as timestampMs };
