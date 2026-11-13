import { toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

/** Cache the bounded tail, independently of any older pages held by the open screen. */
export function threadCacheTail(snapshot: ui.ThreadSnapshot): ui.ThreadSnapshot {
  let bytes = 0;
  const items: ui.TimelineItem[] = [];

  for (const item of snapshot.items.toReversed()) {
    bytes += toBinary(ui.TimelineItemSchema, item).length;

    if (items.length >= 128 || bytes > 384 * 1024) break;
    items.push(item);
  }

  items.reverse();
  const supporting = new Set(items.map((item) => item.turnId));

  const recent = new Set(
    snapshot.turns
      .filter((turn) => turn.status !== "queued")
      .slice(-24)
      .map((turn) => turn.id),
  );

  let queued = 0;
  bytes = 0;

  const turns = snapshot.turns
    .toReversed()
    .filter((turn) => {
      if (!recent.has(turn.id) && !supporting.has(turn.id) && !(turn.status === "queued" && queued++ < 32))
        return false;
      bytes += toBinary(ui.TurnSchema, turn).length;

      return bytes <= 64 * 1024;
    })
    .reverse();

  const kept = new Set(turns.map((turn) => turn.id));
  const tail = items.filter((item) => !item.turnId || kept.has(item.turnId));

  return {
    ...snapshot,
    items: tail,
    turns,
    notices: snapshot.notices.slice(-32),
    interactions: snapshot.interactions.filter((interaction) => interaction.status === "pending").slice(-32),
    steers: snapshot.steers.slice(-32),
    busDeliveries: snapshot.busDeliveries.slice(-32),
    historyHasMore: snapshot.historyHasMore || turns.length < snapshot.turns.length,
    historyItemsHasMore: snapshot.historyItemsHasMore || tail.length < snapshot.items.length,
    historyBeforeTurnId: turns.find((turn) => turn.status !== "queued")?.id ?? snapshot.historyBeforeTurnId,
    historyBeforeItemId: tail[0]?.item?.itemId ?? snapshot.historyBeforeItemId,
  };
}
