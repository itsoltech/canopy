import { timestampMs } from "@bufbuild/protobuf/wkt";
import { ItemStatus } from "@canopy/contracts";
import type { ui } from "@canopy/contracts";
import type { TimelineEntry, TimelineNotice } from "./thread-state.svelte.ts";
import { isSteerMessage, isTerminal, type ItemNode, type TimelineRow } from "./timeline.ts";
import { describeTool } from "./components/items/tools/registry.ts";

/**
 * Each turn's work under a stable "Working for …" / "Worked for …" row:
 * the turn's start, its input, the fold, its final agent message and its footer stay; everything else
 * the turn did — tool and command items, reasoning, intermediate messages, steered messages, background
 * tasks, notices — sits under the fold (`work`), shown after it only while it is open.
 *
 * - A running turn keeps commentary in its work. Without a phase, its latest message stays outside
 *   until more work arrives. The stable answer slot can shrink without removing a virtual row.
 * - The final message is the turn's last agent message. A turn that did not complete (interrupted,
 *   failed) keeps it only when nothing came after it; otherwise its footer (status, reason, Continue)
 *   is the end the reader sees.
 * - Even message-only turns retain the header and the answer slot at completion.
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
  | { readonly kind: "answer"; readonly key: string; readonly turn: ui.Turn; readonly row: TimelineRow | undefined };

export interface WorkSummary {
  /** Turn start to end, ms; undefined without both timestamps. */
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

const isAgentMessage = (row: TimelineRow): boolean =>
  row.kind === "item" && row.node.entry.item.content.case === "agentMessage";

/** An item with nothing to show, without children. */
export function isEmpty(row: TimelineRow): boolean {
  if (row.kind !== "item" || row.node.children.length > 0) return false;
  const content = row.node.entry.item.content;

  if (content.case === "reasoning") return !content.value.text.trim() && !content.value.summary.trim();

  if (content.case === "agentMessage") return !content.value.text.trim();

  return false;
}

export function foldTurns(
  rows: readonly TimelineRow[],
  isOpen: (turnId: string) => boolean,
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

  const folds = new Map<string, { turn: ui.Turn; final: TimelineRow | undefined; work: TimelineRow[] }>();

  for (const [turnId, turn] of turns) {
    const body = bodies.get(turnId) ?? [];
    let at = body.findLastIndex(isAgentMessage);

    if (at >= 0 && turn.status !== "completed" && at !== body.length - 1) at = -1;
    const candidate = body[at];

    if (!isTerminal(turn.status) && candidate?.kind === "item") {
      const content = candidate.node.entry.item.content;

      if (content.case === "agentMessage" && content.value.phase && content.value.phase !== "final_answer") at = -1;
    }

    const final = at >= 0 ? body[at] : undefined;
    const work = body.filter((row) => row !== final);
    folds.set(turnId, { turn, final, work });
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
    const open = isOpen(turnId);
    const groups = toolGroups(fold.work);
    const flat = groups.length === 1 ? groupKey(turnId, groups[0]!) : undefined;
    out.push({
      kind: "work",
      key: `work:${turnId}`,
      turn: fold.turn,
      open,
      summary: summarize(fold.turn, fold.work, tasksBySource),
      flat,
    });

    if (open) out.push(...workRows(fold.turn, fold.work, groups, groupOpen));
    out.push({ kind: "answer", key: `answer:${turnId}`, turn: fold.turn, row: fold.final });

    if (row.kind === "turn-end") out.push({ kind: "row", row, work: false });
  }

  return out;
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

  const spanMs =
    turn.startedAt && turn.completedAt ? timestampMs(turn.completedAt) - timestampMs(turn.startedAt) : undefined;

  return {
    spanMs: spanMs !== undefined && spanMs >= 0 ? spanMs : undefined,
    counts: parts.join(", "),
    running: running.size,
    live: !isTerminal(turn.status),
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

  if (content.case === "interactionPrompt")
    return content.value.routedTo === "parent" ? "Waiting for the parent agent…" : "Waiting for your answer…";

  return "Thinking…";
}

/**
 * Of the turns that just ended, the ones the reader is in: one of the turn's work rows (not its input,
 * not its last agent message — those stay when it folds) among `reading` (row keys on screen or focused,
 * in order). For each, the first such row: it keeps its place when the fold row appears above it.
 */
export function readWork(
  ended: readonly string[],
  reading: readonly string[],
  entries: readonly TimelineEntry[],
  notices: readonly TimelineNotice[],
): Map<string, string> {
  const turnOfKey = new Map<string, string>();
  const finals = new Map<string, TimelineEntry>();

  for (const entry of entries)
    if (entry.item.content.case === "agentMessage" && !entry.item.parentItemId) finals.set(entry.turnId, entry);

  for (const entry of entries) {
    const content = entry.item.content;
    const work = content.case === "userMessage" ? isSteerMessage(entry) : finals.get(entry.turnId) !== entry;

    if (work) turnOfKey.set(`item:${entry.id}`, entry.turnId);
  }

  for (const notice of notices) turnOfKey.set(`notice:${notice.seq}`, notice.turnId);
  const held = new Map<string, string>();

  for (const key of reading) {
    const turnId = turnOfKey.get(key);

    if (turnId && ended.includes(turnId) && !held.has(turnId)) held.set(turnId, key);
  }

  return held;
}
