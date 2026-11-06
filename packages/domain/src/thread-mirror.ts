import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { loadedThreadDelta } from "./history-pages.ts";

export const MIRROR_CURSOR = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+)$/;

/** Idempotent projected upserts: replay after a crash never appends an item or notice twice. */
export function applyThreadDelta(base: ui.ThreadSnapshot, delta: ui.ThreadSnapshotDelta): ui.ThreadSnapshot {
  const next = delta.snapshot;

  if (!next?.thread || next.thread.id !== base.thread?.id) throw new Error("Thread delta does not match its base");
  const removedItems = new Set(delta.removedItemIds);
  const removedTurns = new Set(delta.removedTurnIds);

  const items = new Map(
    base.items.flatMap((item) =>
      item.item && (item.inherited || !removedItems.has(item.item.itemId))
        ? [[`${item.fromThreadId}:${item.item.itemId}`, item] as const]
        : [],
    ),
  );

  const turns = new Map(
    base.turns.flatMap((turn) => (turn.inherited || !removedTurns.has(turn.id) ? [[turn.id, turn] as const] : [])),
  );

  const notices = new Map(base.notices.map((notice) => [notice.seq, notice]));

  for (const seq of delta.removedNoticeSeqs) notices.delete(seq);

  for (const item of next.items) if (item.item) items.set(`${item.fromThreadId}:${item.item.itemId}`, item);

  for (const turn of next.turns) turns.set(turn.id, turn);

  for (const notice of next.notices) notices.set(notice.seq, notice);

  // Inherited chains retain their original order; own upserts follow the home's seq/ordinal.
  return loadedThreadDelta(
    base,
    create(ui.ThreadSnapshotSchema, {
      ...next,
      historyBeforeTurnId: base.historyBeforeTurnId,
      historyHasMore: base.historyHasMore,
      historyVersion: base.historyVersion,
      items: [...items.values()]
        .filter((i) => i.inherited)
        .concat(
          [...items.values()]
            .filter((i) => !i.inherited)
            .sort((a, b) => (a.firstSeq < b.firstSeq ? -1 : a.firstSeq > b.firstSeq ? 1 : 0)),
        ),
      turns: [...turns.values()]
        .filter((t) => t.inherited)
        .concat([...turns.values()].filter((t) => !t.inherited).sort((a, b) => a.ordinal - b.ordinal)),
      notices: [...notices.values()].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0)),
    }),
  );
}
