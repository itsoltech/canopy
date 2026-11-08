import type { ui } from "@canopy/contracts";

import type { ThreadHistoryQuery } from "../store/thread-window.ts";

export type { ThreadHistoryQuery } from "../store/thread-window.ts";

/** Whole-turn keyset pages preserve inputs, work segments and footers, including inherited turns. */
export function threadHistory(snapshot: ui.ThreadSnapshot, query?: ThreadHistoryQuery): ui.ThreadSnapshot {
  if (!query?.pageSize) return snapshot;
  const turns = snapshot.turns.filter((turn) => turn.status !== "queued");
  const reset = !!query.historyVersion && query.historyVersion !== snapshot.historyVersion;

  const boundary =
    !reset && query.beforeTurnId ? turns.findIndex((turn) => turn.id === query.beforeTurnId) : turns.length;

  const end = boundary < 0 ? turns.length : boundary;

  const target =
    !reset && query.targetItemId
      ? snapshot.items.find((entry) => entry.item?.itemId === query.targetItemId)
      : undefined;

  const targetIndex = target ? turns.findIndex((turn) => turn.id === target.turnId) : -1;
  const fromIndex = !reset && query.fromTurnId ? turns.findIndex((turn) => turn.id === query.fromTurnId) : -1;

  const start =
    targetIndex >= 0 ? targetIndex : fromIndex >= 0 ? fromIndex : Math.max(0, end - Math.min(query.pageSize, 100));

  const selected = turns.slice(start, end);
  const ids = new Set(selected.map((turn) => turn.id));

  return {
    ...snapshot,
    turns: snapshot.turns.filter((turn) => turn.status === "queued" || ids.has(turn.id)),
    items: snapshot.items.filter((entry) => !entry.turnId || ids.has(entry.turnId)),
    historyBeforeTurnId: selected[0]?.id ?? "",
    historyHasMore: start > 0,
    historyReset: reset || boundary < 0 || (!!query.fromTurnId && fromIndex < 0),
  };
}
