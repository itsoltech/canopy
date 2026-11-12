import { create } from "@bufbuild/protobuf";
import { ItemStatus, ui } from "@canopy/contracts";
import { validateThreadBatch } from "./thread-sync.ts";
import { loadedThreadDelta, orderThreadTurns } from "./history-pages.ts";

/** Apply the complete batch before publishing its checkpoint to a cache writer. */
export function applyThreadBatch(base: ui.ThreadSnapshot, batch: ui.ThreadSyncBatch) {
  const cursor = base.syncCursor;

  if (!cursor || cursor.epoch !== batch.epoch || cursor.threadId !== batch.threadId)
    throw new Error("Thread sequence identity mismatch");

  if (batch.appliedSeq <= cursor.appliedSeq) {
    validateThreadBatch(batch, batch.baseSeq);

    return base;
  }

  validateThreadBatch(batch, cursor.appliedSeq);
  let next = { ...base };
  const turns = new Map(base.turns.map((v) => [v.id, v]));
  const items = new Map(base.items.map((v) => [v.item?.itemId ?? "", v]));
  const notices = new Map(base.notices.map((v) => [v.seq.toString(), v]));
  const interactions = new Map(base.interactions.map((v) => [v.requestId, v]));
  const steers = new Map(base.steers.map((v) => [v.id, v]));
  const deliveries = new Map(base.busDeliveries.map((v) => [v.callId, v]));

  for (const record of batch.records) {
    const separator = record.key.indexOf(":");
    const kind = record.key.slice(0, separator).replace(/^legacy_/, "");
    const id = record.key.slice(separator + 1);

    if (record.removed) {
      switch (kind) {
        case "turn":
          turns.delete(id);
          break;
        case "item":
          items.delete(id);
          break;
        case "notice":
          notices.delete(id);
          break;
        case "interaction":
          interactions.delete(id);
          break;
        case "steer":
          steers.delete(id);
          break;
        case "delivery":
          deliveries.delete(id);
          break;
        case "goal":
          next.goal = undefined;
          break;
      }

      continue;
    }

    const value = record.value;

    switch (value.case) {
      case "thread":
        next.thread = value.value;
        break;
      case "turn":
        turns.set(value.value.id, value.value);
        break;
      case "item":
        if (value.value.item) {
          const item = value.value;
          const first = base.items.find((entry) => entry.fromThreadId === item.fromThreadId);

          const outside =
            base.historyItemsHasMore &&
            !items.has(item.item!.itemId) &&
            (first ? item.firstSeq < first.firstSeq : item.inherited);

          if (!outside) items.set(item.item!.itemId, item);
        }

        break;
      case "notice":
        notices.set(value.value.seq.toString(), value.value);
        break;
      case "interaction":
        interactions.set(value.value.requestId, value.value);
        break;
      case "goal":
        next.goal = value.value;
        break;
      case "steer":
        steers.set(value.value.id, value.value);
        break;
      case "busDelivery":
        deliveries.set(value.value.callId, value.value);
        break;
      default:
        if (kind === "item" && !items.has(id))
          items.set(
            id,
            create(ui.TimelineItemSchema, {
              firstSeq: record.position,
              item: {
                itemId: id,
                status: ItemStatus.COMPLETED,
                content: {
                  case: "agentMessage",
                  value: { text: "This item is unavailable in this version of Canopy." },
                },
              },
            }),
          );
    }
  }

  next = {
    ...next,
    turns: orderThreadTurns([...turns.values()]),
    items: [...items.values()].sort(
      (a, b) =>
        Number(b.inherited) - Number(a.inherited) || (a.firstSeq < b.firstSeq ? -1 : a.firstSeq > b.firstSeq ? 1 : 0),
    ),
    notices: [...notices.values()].slice(-200),
    interactions: [...interactions.values()],
    steers: [...steers.values()],
    busDeliveries: [...deliveries.values()],
    syncCursor: create(ui.ThreadSyncCursorSchema, {
      threadId: batch.threadId,
      epoch: batch.epoch,
      appliedSeq: batch.appliedSeq,
    }),
    cursor: `range:${batch.epoch}:${batch.appliedSeq}`,
    lastSeq: next.thread?.lastSeq ?? base.lastSeq,
  };

  return loadedThreadDelta(base, next);
}
