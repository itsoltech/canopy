import type { ui } from "@canopy/contracts";
import type { FeedRow } from "./feed.ts";

export type RewindFeedRow = {
  readonly kind: "rewind";
  readonly key: string;
  readonly rewindId: string;
  readonly messages: number;
  readonly open: boolean;
  readonly canUndo: boolean;
};

function turnId(row: FeedRow): string | undefined {
  if (row.kind === "work" || row.kind === "work-group" || row.kind === "answer" || row.kind === "work-gap")
    return row.turn.id;

  if (row.kind !== "timeline") return;

  if (row.row.kind === "item") return row.row.node.entry.turnId;

  if (row.row.kind === "notice") return row.row.notice.turnId;

  return row.row.turn.id;
}

/** Every row of a superseded turn follows its fold, including late tool/background events. */
export function rewindRows(rows: FeedRow[], turns: readonly ui.Turn[], open: ReadonlySet<string>): FeedRow[] {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const groups = new Map<string, ui.Turn[]>();

  for (const turn of turns) {
    if (!turn.rewindId) continue;
    const list = groups.get(turn.rewindId) ?? [];
    list.push(turn);
    groups.set(turn.rewindId, list);
  }

  const emitted = new Set<string>();
  const result: FeedRow[] = [];

  for (const row of rows) {
    const turn = byId.get(turnId(row) ?? "");
    const id = turn?.rewindId;

    if (!id) {
      // The compact fold replaces the durable event's generic success notice.
      if (row.kind !== "timeline" || row.row.kind !== "notice" || row.row.notice.notice.code !== "thread_rewound")
        result.push(row);
      continue;
    }

    if (!emitted.has(id)) {
      emitted.add(id);
      const group = groups.get(id) ?? [];
      const first = Math.min(...group.map((entry) => entry.ordinal));
      result.push({
        kind: "rewind",
        key: `rewind:${id}`,
        rewindId: id,
        messages: group.filter((entry) => entry.trigger === "user" && !entry.withdrawn).length,
        open: open.has(id),
        canUndo:
          !turns.some((entry) => !entry.rewindId && entry.ordinal >= first) &&
          !turns.some((entry) => entry.rewindId && entry.rewindId !== id && entry.ordinal > first),
      });
    }

    if (open.has(id)) result.push(row);
  }

  return result;
}
