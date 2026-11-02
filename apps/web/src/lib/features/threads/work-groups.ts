import { timestampMs } from "@bufbuild/protobuf/wkt";
import { ItemStatus } from "@open-agents/contracts";
import type { ui } from "@open-agents/contracts";
import type { TimelineEntry, TimelineNotice } from "./thread-state.svelte.ts";
import { isSteerMessage, isTerminal, type ItemNode, type TimelineRow } from "./timeline.ts";

/**
 * A timeline with each ended turn's work folded into one "Worked for …" row (like the Codex app):
 * the turn's start, its input, the fold, its final agent message and its footer stay; everything else
 * the turn did — tool and command items, reasoning, intermediate messages, steered messages, background
 * tasks, notices — sits under the fold (`work`), shown after it only while it is open.
 *
 * - A running turn is never folded.
 * - The final message is the turn's last agent message. A turn that did not complete (interrupted,
 *   failed) keeps it only when nothing came after it; otherwise its footer (status, reason, Continue)
 *   is the end the reader sees.
 * - Nothing to fold (no work beside the final message): the turn stays as it is.
 * - Items an ended turn left without anything to show (reasoning without text or summary — Codex
 *   keeps encrypted reasoning only —, an agent message without text) are dropped: they neither make a
 *   fold nor sit in one.
 * - Rows of other turns or between turns inside a folded turn's span follow its fold (their order to
 *   each other and to the footer is kept).
 */
export type FoldedRow =
  | { readonly kind: "row"; readonly row: TimelineRow; readonly work: boolean }
  | { readonly kind: "work"; readonly key: string; readonly turn: ui.Turn; readonly open: boolean; readonly summary: WorkSummary };

export interface WorkSummary {
  /** Turn start to end, ms; undefined without both timestamps. */
  readonly spanMs: number | undefined;
  /** What the fold holds, e.g. "3 commands, 1 edit" (the most telling kinds, at most three). */
  readonly counts: string;
  /** Items still in progress under the fold (background tasks keep running after the turn). */
  readonly running: number;
}

const turnIdOf = (row: TimelineRow): string =>
  row.kind === "item" ? row.node.entry.turnId : row.kind === "notice" ? row.notice.turnId : row.turn.id;

/** Rows of the turn that are its work or its final message (not its frame or input). */
const isBody = (row: TimelineRow): boolean => (row.kind === "item" && !row.inputOf) || row.kind === "notice";

const isAgentMessage = (row: TimelineRow): boolean => row.kind === "item" && row.node.entry.item.content.case === "agentMessage";

/** An item with nothing to show, without children. */
function isEmpty(row: TimelineRow): boolean {
  if (row.kind !== "item" || row.node.children.length > 0) return false;
  const content = row.node.entry.item.content;
  if (content.case === "reasoning") return !content.value.text.trim() && !content.value.summary.trim();
  if (content.case === "agentMessage") return !content.value.text.trim();
  return false;
}

export function foldTurns(rows: readonly TimelineRow[], isOpen: (turnId: string) => boolean): FoldedRow[] {
  // Ended turns (they have a footer) and their body rows in order.
  const ended = new Map<string, ui.Turn>();
  for (const row of rows) if (row.kind === "turn-end" && isTerminal(row.turn.status)) ended.set(row.turn.id, row.turn);
  const bodies = new Map<string, TimelineRow[]>();
  for (const row of rows) {
    const turnId = turnIdOf(row);
    if (!ended.has(turnId) || !isBody(row) || isEmpty(row)) continue;
    const list = bodies.get(turnId);
    if (list) list.push(row);
    else bodies.set(turnId, [row]);
  }
  const folds = new Map<string, { turn: ui.Turn; final: TimelineRow | undefined; work: TimelineRow[] }>();
  for (const [turnId, body] of bodies) {
    const turn = ended.get(turnId)!;
    let at = body.findLastIndex(isAgentMessage);
    if (at >= 0 && turn.status !== "completed" && at !== body.length - 1) at = -1;
    const final = at >= 0 ? body[at] : undefined;
    const work = body.filter((row) => row !== final);
    if (work.length > 0) folds.set(turnId, { turn, final, work });
  }

  const out: FoldedRow[] = [];
  const placed = new Set<string>();
  for (const row of rows) {
    const turnId = turnIdOf(row);
    if (ended.has(turnId) && isBody(row) && isEmpty(row)) continue;
    const fold = folds.get(turnId);
    if (!fold || !isBody(row)) {
      out.push({ kind: "row", row, work: false });
      continue;
    }
    if (placed.has(turnId)) continue;
    placed.add(turnId);
    const open = isOpen(turnId);
    out.push({ kind: "work", key: `work:${turnId}`, turn: fold.turn, open, summary: summarize(fold.turn, fold.work) });
    if (open) for (const work of fold.work) out.push({ kind: "row", row: work, work: true });
    if (fold.final) out.push({ kind: "row", row: fold.final, work: false });
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

function summarize(turn: ui.Turn, work: readonly TimelineRow[]): WorkSummary {
  const counts = new Map<string, number>();
  let running = 0;
  const visit = (node: ItemNode) => {
    if (node.entry.item.status === ItemStatus.IN_PROGRESS) running++;
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
  const spanMs = turn.startedAt && turn.completedAt ? timestampMs(turn.completedAt) - timestampMs(turn.startedAt) : undefined;
  return { spanMs: spanMs !== undefined && spanMs >= 0 ? spanMs : undefined, counts: parts.join(", "), running };
}

/**
 * Of the turns that just ended, the ones the reader is in: one of the turn's work rows (not its input,
 * not its last agent message — those stay when it folds) among `reading` (row keys on screen or focused,
 * in order). For each, the first such row: it keeps its place when the fold row appears above it.
 */
export function readWork(ended: readonly string[], reading: readonly string[], entries: readonly TimelineEntry[], notices: readonly TimelineNotice[]): Map<string, string> {
  const turnOfKey = new Map<string, string>();
  const finals = new Map<string, TimelineEntry>();
  for (const entry of entries) if (entry.item.content.case === "agentMessage" && !entry.item.parentItemId) finals.set(entry.turnId, entry);
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
