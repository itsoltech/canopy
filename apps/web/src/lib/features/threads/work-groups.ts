import { timestampMs } from "@bufbuild/protobuf/wkt";
import { ItemStatus } from "@canopy/contracts";
import type { ui } from "@canopy/contracts";
import type { TimelineEntry } from "./thread-state.svelte.ts";
import type { ItemNode, TimelineRow } from "./timeline.ts";
import { describeTool } from "./components/items/tools/registry.ts";
import { blank } from "./work-segments.ts";
import { foldId, turnProgress, workSegments, type BodyRow, type WorkSegment } from "@canopy/domain/work-fold";

/**
 * Each turn's work under a stable "Working for …" / "Worked for …" row:
 * the turn's start, its input, the fold, its final agent message and its footer stay; everything else
 * the turn did — tool and command items, reasoning, intermediate messages, steered messages, background
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
 *   segment (`workSegments`), its leading steers above a fold and answer slot of its own (`fold`: the
 *   segment's fold id, `foldId`).
 * - Empty reasoning and messages add no visible work. Later text deltas can make them visible.
 * - Other turns and background work without a turn keep their own order.
 * - Consecutive tools form a group under its own header when the work has several such phases. A sole
 *   group would only repeat the fold's counts: its rows follow the open fold directly (`flat`).
 */
export type FoldedRow =
  | { readonly kind: "row"; readonly row: TimelineRow; readonly work: boolean }
  | {
      readonly kind: "work";
      readonly key: string;
      readonly fold: string;
      readonly turn: ui.Turn;
      readonly open: boolean;
      readonly summary: WorkSummary;
      /** Key of the sole tool group shown without its header; it opens if a live turn adds a second. */
      readonly flat: string | undefined;
    }
  | {
      readonly kind: "work-group";
      readonly key: string;
      readonly turn: ui.Turn;
      readonly open: boolean;
      readonly label: string;
      readonly running: boolean;
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

  for (const row of rows) if (row.kind === "turn-start" || row.kind === "turn-end") turns.set(row.turn.id, row.turn);

  const inputs = new Set(
    rows.flatMap((r) => (r.kind === "input" || (r.kind === "item" && r.inputOf) ? [turnIdOf(r)] : [])),
  );

  const bodies = new Map<string, TimelineRow[]>();

  for (const row of rows) {
    const turnId = turnIdOf(row);

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
    } else if (row.kind === "turn-end") {
      if (placed.has(turnId)) {
        out.push({ kind: "row", row, work: false });
        continue;
      }
    }

    if (placed.has(turnId)) continue;

    if (!fold) continue;
    placed.add(turnId);

    for (let index = 0; index < fold.segments.length; index++)
      out.push(...segmentRows(fold, index, isOpen, groupOpen, tasksBySource));

    if (row.kind === "turn-end") out.push({ kind: "row", row, work: false });
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
    flat: groups.length === 1 ? groupKey(turn.id, groups[0]!) : undefined,
  });

  if (open) out.push(...workRows(turn, work, groups, groupOpen));
  out.push({ kind: "answer", key: `answer:${id}`, fold: id, turn, row: final });

  return out;
}

/** When a segment ran: from the turn's start or the previous answer's end, to its own answer's end or the turn's. */
function segmentTimes(fold: TurnFold, index: number): SegmentTimes {
  const { turn, body, segments } = fold;

  const answerEnd = (at: number | undefined) => {
    const row = at === undefined ? undefined : body[at];

    return row?.kind === "item" ? row.node.entry.completedAt : undefined;
  };

  const ms = (time: ui.Turn["startedAt"]) => (time ? timestampMs(time) : undefined);

  return {
    startMs: index === 0 ? ms(turn.startedAt) : answerEnd(segments[index - 1]?.answer),
    endMs: index === segments.length - 1 ? ms(turn.completedAt) : answerEnd(segments[index]?.answer),
    live: segments[index]?.live ?? false,
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

/** An open fold's rows: other work as it is, tools under their group's header (a sole group has none). */
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

    if (!tools || groups.length === 1) {
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
        label: groupSummary(tools),
        running: tools.some((r) => r.kind === "item" && r.node.entry.item.status === ItemStatus.IN_PROGRESS),
        items: tools.map((r) => r.key),
      });

    if (open) out.push({ kind: "row", row, work: true });
  }

  return out;
}

const KINDS: readonly (readonly [string, string, string])[] = [
  ["commandExecution", "command", "commands"],
  ["fileChange", "edit", "edits"],
  ["toolCall", "tool call", "tool calls"],
  ["agentBusCall", "agent call", "agent calls"],
  ["subagent", "subagent", "subagents"],
  ["webSearch", "search", "searches"],
  ["backgroundTask", "background task", "background tasks"],
  ["agentMessage", "message", "messages"],
  ["userMessage", "steered message", "steered messages"],
];

function summarize(
  turn: ui.Turn,
  work: readonly TimelineRow[],
  tasksBySource: ReadonlyMap<string, TimelineEntry>,
  { startMs, endMs, live }: SegmentTimes,
): WorkSummary {
  const counts = new Map<string, number>();
  const running = new Set<string>();

  const visit = (node: ItemNode) => {
    const entry = tasksBySource.get(node.entry.id) ?? node.entry;

    if (entry.item.status === ItemStatus.IN_PROGRESS) running.add(entry.id);
    node.children.forEach(visit);
  };

  for (const row of work) {
    if (row.kind !== "item") continue;
    const kind = row.node.entry.item.content.case ?? "";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    visit(row.node);
  }

  const parts = KINDS.filter(([kind]) => counts.has(kind))
    .slice(0, 3)
    .map(([kind, one, many]) => {
      const n = counts.get(kind)!;

      return `${n} ${n === 1 ? one : many}`;
    });

  const spanMs = startMs !== undefined && endMs !== undefined ? endMs - startMs : undefined;

  return {
    startMs,
    spanMs: spanMs !== undefined && spanMs >= 0 ? spanMs : undefined,
    counts: parts.join(", "),
    running: running.size,
    live,
    hint: currentWorkHint(work, tasksBySource),
    size: work.length,
  };
}

const isToolRow = (row: TimelineRow): boolean =>
  row.kind === "item" && !["agentMessage", "userMessage", "reasoning"].includes(row.node.entry.item.content.case ?? "");

type Activity =
  | "read"
  | "command"
  | "edit"
  | "search"
  | "tool"
  | "agent call"
  | "subagent"
  | "background task"
  | "item";

/** Items other than tool calls, by their content case. */
const ITEM_ACTIVITIES = new Map<string, Activity>([
  ["commandExecution", "command"],
  ["fileChange", "edit"],
  ["webSearch", "search"],
  ["agentBusCall", "agent call"],
  ["subagent", "subagent"],
  ["backgroundTask", "background task"],
]);

function activity(row: TimelineRow): Activity | undefined {
  if (row.kind !== "item") return undefined;
  const content = row.node.entry.item.content;

  if (content.case === "toolCall") {
    const call = content.value;
    const body = describeTool({ ...call, running: true }).body;

    if (body === "read") return "read";

    if (body === "shell") return "command";

    if (body === "edit" || body === "patch") return "edit";

    if (body === "search" || body === "files" || body === "web-search") return "search";

    return "tool";
  }

  return ITEM_ACTIVITIES.get(content.case ?? "") ?? "item";
}

const VERBS = {
  read: ["Read", "file", "files"],
  command: ["Ran", "command", "commands"],
  edit: ["Made", "edit", "edits"],
  search: ["Ran", "search", "searches"],
  tool: ["Made", "tool call", "tool calls"],
  "agent call": ["Made", "agent call", "agent calls"],
  subagent: ["Started", "subagent", "subagents"],
  "background task": ["Started", "background task", "background tasks"],
  item: ["Updated", "item", "items"],
} satisfies Record<Activity, readonly [string, string, string]>;

/** Consecutive tools form one stable group, until a progress message/reasoning/notice separates them. */
export function groupSummary(rows: readonly TimelineRow[]): string {
  const counts = new Map<Activity, number>();

  for (const row of rows) {
    const kind = activity(row) ?? "item";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  return [...counts]
    .map(([kind, n], i) => {
      const [verb, one, many] = VERBS[kind];

      return `${i ? verb.toLowerCase() : verb} ${n} ${n === 1 ? one : many}`;
    })
    .join(" and ");
}

/** Only active work supplies a live hint; finished calls never masquerade as still running. */
export function currentWorkHint(
  rows: readonly TimelineRow[],
  tasksBySource: ReadonlyMap<string, TimelineEntry> = new Map(),
): string {
  const active = rows.filter(
    (r) =>
      r.kind === "item" && (tasksBySource.get(r.node.entry.id) ?? r.node.entry).item.status === ItemStatus.IN_PROGRESS,
  );

  const reads = active.filter((r) => activity(r) === "read");
  const row = active.at(-1);

  if (!row || row.kind !== "item") return "Thinking…";

  if (activity(row) === "read" && reads.length > 1) return `Reading ${reads.length} files…`;
  const content = row.node.entry.item.content;

  if (content.case === "commandExecution") return `Running ${content.value.command.split("\n")[0]}…`;

  if (content.case === "toolCall") {
    const look = describeTool({ ...content.value, running: true });

    return `${look.title}${look.subject ? ` ${look.subject}` : ""}…`;
  }

  if (content.case === "fileChange") return `Editing ${content.value.changes.length} files…`;

  if (content.case === "backgroundTask") return content.value.description || "Running a background task…";

  if (content.case === "agentBusCall") return `Calling ${content.value.toolName}…`;

  if (content.case === "subagent") return content.value.description || "Waiting for a subagent…";

  // A message still streaming inside a collapsed fold: its text shows only once it is the answer.
  if (content.case === "agentMessage") return "Writing…";

  if (content.case === "interactionPrompt")
    return content.value.routedTo === "parent" ? "Waiting for the parent agent…" : "Waiting for your answer…";

  return "Thinking…";
}
