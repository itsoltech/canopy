import type { ui } from "@canopy/contracts";
import { dayKey } from "#lib/shared/format.ts";
import type { TimelineEntry, TimelineNotice, TurnResult } from "./thread-state.svelte.ts";

/** An item with the items nested under it (subagent work has `parent_item_id`). */
export interface ItemNode {
  readonly entry: TimelineEntry;
  readonly children: readonly ItemNode[];
}

export type TimelineRow =
  /**
   * `newDay`: the turn starts a day the timeline has not shown yet (the first turn starts one too). `number`: the
   * turn's place among the shown turns (its ordinal less the withdrawn turns before it).
   */
  | { readonly kind: "turn-start"; readonly key: string; readonly turn: ui.Turn; readonly newDay: boolean; readonly number: number }
  /** The turn's input before the provider echoes it as a user_message item. */
  | { readonly kind: "input"; readonly key: string; readonly turn: ui.Turn }
  /**
   * `inputOf`: the item is the turn's input (user_message), shown with where it came from. `steer`: a
   * message that joined the turn while it ran (a user_message whose `client_id` is a steer's id).
   */
  | { readonly kind: "item"; readonly key: string; readonly node: ItemNode; readonly inputOf: ui.Turn | undefined; readonly steer: boolean }
  | { readonly kind: "notice"; readonly key: string; readonly notice: TimelineNotice }
  /** `answer`: the text of the turn's last agent message (what "Copy answer" copies); "" without one. */
  | { readonly kind: "turn-end"; readonly key: string; readonly turn: ui.Turn; readonly result: TurnResult | undefined; readonly answer: string };

/**
 * A user_message that joined a running turn (steer): its `client_id` is the steer's id. The turn's own
 * input carries the turn id (or none, when the provider does not know it).
 */
export function isSteerMessage(entry: TimelineEntry): boolean {
  const content = entry.item.content;
  return content.case === "userMessage" && content.value.clientId !== "" && content.value.clientId !== entry.turnId;
}

/** The item a nested one sits under at the top level (its own row in the timeline); itself when not nested. */
export function topLevelEntry(entries: readonly TimelineEntry[], entry: TimelineEntry): TimelineEntry {
  const byId = new Map(entries.map((e) => [e.id, e]));
  let top = entry;
  for (let depth = 0; depth < 50; depth++) {
    const parent = top.item.parentItemId ? byId.get(top.item.parentItemId) : undefined;
    if (!parent || parent === top) break;
    top = parent;
  }
  return top;
}

const TERMINAL = new Set(["completed", "interrupted", "failed", "cancelled"]);
export const isTerminal = (status: string) => TERMINAL.has(status);

type Element = { seq: bigint; turnId: string } & ({ node: ItemNode } | { notice: TimelineNotice });

/**
 * Orders items and notices by seq and frames each turn: a start row before its first element (marking a
 * new day) and an end row (status, usage, the last answer) after its last one. Items of other turns or between turns (background
 * work) keep their place in the sequence. Turns without any element yet (just started, or failed
 * before the provider ran) follow at the end; queued turns are not rows (the page shows them apart), nor
 * are turns the user took out of the queue (`withdrawn`: deleted, or steered into another turn).
 * `nodes` keeps item nodes between builds: an unchanged item (and nested items) keeps its node object.
 */
export function buildTimeline(
  entries: readonly TimelineEntry[],
  turns: readonly ui.Turn[],
  notices: readonly TimelineNotice[],
  results: ReadonlyMap<string, TurnResult>,
  nodes?: WeakMap<TimelineEntry, ItemNode>,
): TimelineRow[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const childrenOf = new Map<string, TimelineEntry[]>();
  const top: TimelineEntry[] = [];
  for (const entry of entries) {
    const parent = entry.item.parentItemId;
    if (!parent || parent === entry.id || !byId.has(parent)) top.push(entry);
    else if (childrenOf.has(parent)) childrenOf.get(parent)!.push(entry);
    else childrenOf.set(parent, [entry]);
  }
  const node = (entry: TimelineEntry, seen: Set<string>): ItemNode => {
    seen.add(entry.id);
    const children = (childrenOf.get(entry.id) ?? []).filter((c) => !seen.has(c.id)).map((c) => node(c, seen));
    const previous = nodes?.get(entry);
    if (previous && previous.children.length === children.length && previous.children.every((c, i) => c === children[i])) return previous;
    const next = { entry, children };
    nodes?.set(entry, next);
    return next;
  };

  const elements: Element[] = [
    ...top.map((entry) => ({ seq: entry.firstSeq, turnId: entry.turnId, node: node(entry, new Set()) })),
    ...notices.map((notice) => ({ seq: notice.seq, turnId: notice.turnId, notice })),
  ].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

  const withdrawn = turns.filter((t) => t.withdrawn).map((t) => t.ordinal);
  const number = (turn: ui.Turn) => turn.ordinal - withdrawn.filter((o) => o < turn.ordinal).length;
  turns = turns.filter((t) => !t.withdrawn);
  const turnById = new Map(turns.map((t) => [t.id, t]));
  const lastIndex = new Map<string, number>();
  elements.forEach((element, index) => element.turnId && lastIndex.set(element.turnId, index));
  const echoed = new Set(entries.filter((e) => e.item.content.case === "userMessage" && !isSteerMessage(e)).map((e) => e.turnId));

  const answers = new Map<string, string>();
  for (const element of elements) {
    const content = "node" in element ? element.node.entry.item.content : undefined;
    if (content?.case === "agentMessage" && content.value.text.trim()) answers.set(element.turnId, content.value.text);
  }

  const rows: TimelineRow[] = [];
  const opened = new Set<string>();
  let lastDay = "";
  const open = (turn: ui.Turn) => {
    opened.add(turn.id);
    const day = dayKey(turn.startedAt ?? turn.queuedAt);
    rows.push({ kind: "turn-start", key: `start:${turn.id}`, turn, newDay: day !== "" && day !== lastDay, number: number(turn) });
    if (day) lastDay = day;
    if (!echoed.has(turn.id) && turn.inputText) rows.push({ kind: "input", key: `input:${turn.id}`, turn });
  };
  const close = (turn: ui.Turn) => {
    if (isTerminal(turn.status)) rows.push({ kind: "turn-end", key: `end:${turn.id}`, turn, result: results.get(turn.id), answer: answers.get(turn.id) ?? "" });
  };

  elements.forEach((element, index) => {
    const turn = element.turnId ? turnById.get(element.turnId) : undefined;
    if (turn && !opened.has(turn.id)) open(turn);
    if ("node" in element) {
      const steer = isSteerMessage(element.node.entry);
      const inputOf = element.node.entry.item.content.case === "userMessage" && !steer ? turn : undefined;
      rows.push({ kind: "item", key: `item:${element.node.entry.id}`, node: element.node, inputOf, steer });
    } else rows.push({ kind: "notice", key: `notice:${element.seq}`, notice: element.notice });
    if (turn && lastIndex.get(turn.id) === index) close(turn);
  });

  for (const turn of turns) {
    if (opened.has(turn.id) || turn.status === "queued") continue;
    open(turn);
    close(turn);
  }
  return rows;
}
