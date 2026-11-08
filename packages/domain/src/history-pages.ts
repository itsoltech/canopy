import { create } from "@bufbuild/protobuf";
import { bots, ui } from "@canopy/contracts";

/** Fork ancestors retain chain order; this thread's turns use their gateway ordinal, including empty turns. */
export function orderThreadTurns(turns: readonly ui.Turn[]): ui.Turn[] {
  return turns
    .filter((turn) => turn.inherited)
    .concat(turns.filter((turn) => !turn.inherited).sort((a, b) => a.ordinal - b.ordinal));
}

/** Page reads never advance a live checkpoint or overwrite a newer row already received on the watch. */
export function prependThreadPage(
  current: ui.ThreadSnapshot,
  page: ui.ThreadSnapshot,
  checkpoint = current.cursor,
): ui.ThreadSnapshot {
  if (page.thread?.id !== current.thread?.id) throw new Error("Thread page identity mismatch");

  if (page.historyReset || (page.historyVersion && current.historyVersion !== page.historyVersion))
    throw new Error("Thread history changed");
  const turns = new Set(current.turns.map((turn) => turn.id));
  const items = new Set(current.items.map((entry) => `${entry.fromThreadId}:${entry.item?.itemId}`));

  return create(ui.ThreadSnapshotSchema, {
    ...current,
    cursor: checkpoint,
    turns: orderThreadTurns([...page.turns.filter((turn) => !turns.has(turn.id)), ...current.turns]),
    items: [
      ...page.items.filter((entry) => !items.has(`${entry.fromThreadId}:${entry.item?.itemId}`)),
      ...current.items,
    ],
    historyBeforeTurnId: page.historyBeforeTurnId,
    historyHasMore: page.historyHasMore,
  });
}

type BotHistory = bots.BotConversation | bots.ReadBotExchangeResponse;

export function prependBotPage<T extends BotHistory>(current: T, page: T, checkpoint = current.cursor): T {
  if (page.historyReset) throw new Error("Bot history changed");
  const ids = new Set(current.messages.map((message) => message.id));

  return {
    ...current,
    cursor: checkpoint,
    messages: [...page.messages.filter((message) => !ids.has(message.id)), ...current.messages].sort((a, b) =>
      a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : a.id.localeCompare(b.id),
    ),
    historyBeforeSeq: page.historyBeforeSeq,
    historyHasMore: page.historyHasMore,
  };
}

/** Ignore edits outside a loaded tail. They are read authoritatively when that older page is requested. */
export function loadedThreadDelta(base: ui.ThreadSnapshot, next: ui.ThreadSnapshot): ui.ThreadSnapshot {
  if (!base.historyHasMore) return next;
  const first = base.turns.find((turn) => turn.id === base.historyBeforeTurnId);

  if (!first || first.inherited) return next;

  const turns = next.turns.filter(
    (turn) => turn.inherited || turn.status === "queued" || turn.ordinal >= first.ordinal,
  );

  const ids = new Set(turns.map((turn) => turn.id));

  return { ...next, turns, items: next.items.filter((entry) => !entry.turnId || ids.has(entry.turnId)) };
}
