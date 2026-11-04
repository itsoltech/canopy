import type { Timestamp } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import type { FeedRow } from "../feed.ts";
import { turnIdOf } from "../work-groups.ts";
import type { FeedViewport } from "#lib/shared/ui/virtual/viewport.ts";

export interface RailTurn {
  readonly id: string;
  readonly number: number;
  /** Header for visible-range lookup; input row for jumping. */
  readonly start: number;
  readonly row: number;
  readonly title: string;
  readonly answer: string;
  readonly time: Timestamp | undefined;
  readonly running: boolean;
}

/** Uses feed indices, so opening work/history folds automatically updates navigation. */
export function railTurns(rows: readonly FeedRow[]): RailTurn[] {
  const turns: RailTurn[] = [];
  const byId = new Map<string, number>();
  rows.forEach((feed, index) => {
    const row = feed.kind === "timeline" || feed.kind === "answer" ? feed.row : undefined;

    if (!row) return;

    if (row.kind === "turn-start") {
      byId.set(row.turn.id, turns.length);
      turns.push({
        id: row.turn.id,
        number: row.number,
        start: index,
        row: index,
        title: turnTitle(row.turn),
        answer: "",
        time: row.turn.startedAt ?? row.turn.queuedAt,
        running: row.turn.status === "running",
      });

      return;
    }

    const id = turnIdOf(row);
    const at = byId.get(id);
    const turn = at === undefined ? undefined : turns[at];

    if (!turn || at === undefined) return;

    if (row.kind === "input" || (row.kind === "item" && row.inputOf)) {
      const text =
        row.kind === "item" && row.node.entry.item.content.case === "userMessage"
          ? row.node.entry.item.content.value.text
          : turn.title;

      turns[at] = {
        ...turn,
        row: index,
        title:
          row.kind === "input" ? turnTitle(row.turn) : row.inputOf ? turnTitle(row.inputOf, text) : previewTitle(text),
      };
    } else if (row.kind === "turn-end" && row.answer) {
      turns[at] = { ...turn, answer: row.answer.slice(0, 2000) };
    } else if (row.kind === "item" && row.node.entry.item.content.case === "agentMessage") {
      const message = row.node.entry.item.content.value;

      if (!turn.answer || message.phase === "final_answer")
        turns[at] = { ...turn, answer: message.text.slice(0, 2000) };
    }
  });

  return turns;
}

const previewTitle = (text: string): string =>
  text.replace(/\s+/g, " ").trim().slice(0, 240) || "Message with attachments";

function turnTitle(turn: ui.Turn, echoed = turn.inputText): string {
  const rich = turn.platformNote || turn.attachments.length || turn.mentions.length || turn.quotes.length;

  return previewTitle(rich ? turn.messageText : turn.messageText || echoed);
}

export interface RailTick {
  /** Turn indices [start, end), merged only visually. Every turn retains its button. */
  readonly start: number;
  readonly end: number;
  readonly y: number;
}

/** At least 4px per visible tick; no scrolling, even with thousands of turns. */
export function railTicks(count: number, height: number): RailTick[] {
  if (count <= 0 || height <= 0) return [];
  const capacity = Math.min(count, Math.max(1, Math.floor(height / 4)));

  return Array.from({ length: capacity }, (_, i) => ({
    start: Math.floor((i * count) / capacity),
    end: Math.floor(((i + 1) * count) / capacity),
    y: ((i + 0.5) * height) / capacity,
  }));
}

/** Visible turns [start, end), using binary search; never uses the virtualizer's overscan. */
export function currentTurns(
  turns: readonly Pick<RailTurn, "start">[],
  viewport: Pick<FeedViewport, "start" | "end">,
): readonly [number, number] {
  if (!turns.length || viewport.end <= viewport.start || viewport.end <= turns[0]!.start) return [0, 0];

  const covering = (row: number) => {
    let low = 0;
    let high = turns.length - 1;

    while (low < high) {
      const mid = (low + high + 1) >> 1;

      if (turns[mid]!.start <= row) low = mid;
      else high = mid - 1;
    }

    return low;
  };

  return [covering(viewport.start), covering(viewport.end - 1) + 1];
}
