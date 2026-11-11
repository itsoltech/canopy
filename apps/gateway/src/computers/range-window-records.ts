import { toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { appendRecord } from "./range-record.ts";

/** Keep continuous item/turn prefixes, charging each item's supporting turn to its byte budget. */
export function appendClientWindow(
  snapshot: ui.ThreadSnapshot,
  records: ui.ThreadSyncRecord[],
  turnIds: string[],
  sizes: ReadonlyMap<ui.ThreadSyncRecord, number> = new Map(
    records.map((record) => [record, toBinary(ui.ThreadSyncRecordSchema, record).length]),
  ),
) {
  const turns = new Map(
    records.flatMap((record) => (record.value.case === "turn" ? [[record.value.value.id, record] as const] : [])),
  );

  const present = new Set<string>();
  let metadataBytes = 0;
  let turnBytes = 0;
  let itemBytes = 0;

  for (const record of records) {
    if (record.value.case === "item" || record.value.case === "turn") continue;
    const size = sizes.get(record)!;

    if (metadataBytes + size > 64 * 1024) continue;
    metadataBytes += size;
    appendRecord(snapshot, record);
  }

  let beforeTurn = "";

  for (const id of turnIds) {
    const record = turns.get(id);

    if (!record) continue;
    const size = sizes.get(record)!;

    if (turnBytes + size > 64 * 1024) {
      snapshot.historyHasMore = true;
      break;
    }

    turnBytes += size;
    present.add(id);
    beforeTurn = id;
    appendRecord(snapshot, record);
  }

  snapshot.historyBeforeTurnId = beforeTurn || snapshot.historyBeforeTurnId;

  for (const record of records) {
    if (record.value.case !== "item") continue;
    const turnId = record.value.value.turnId;
    const supporting = !present.has(turnId) ? turns.get(turnId) : undefined;
    const size = sizes.get(record)! + (supporting ? sizes.get(supporting)! : 0);

    if (itemBytes + size > 384 * 1024) {
      snapshot.historyItemsHasMore = true;
      break;
    }

    itemBytes += size;

    if (supporting) {
      appendRecord(snapshot, supporting);
      present.add(turnId);
    }

    appendRecord(snapshot, record);
  }

  for (const [id, record] of turns) {
    if (present.has(id) || record.value.case !== "turn" || record.value.value.status !== "queued") continue;
    const size = sizes.get(record)!;

    if (turnBytes + size > 64 * 1024) break;
    turnBytes += size;
    appendRecord(snapshot, record);
  }

  snapshot.items.reverse();
  snapshot.turns.sort((a, b) => {
    const first = turns.get(a.id)?.position ?? 0n;
    const second = turns.get(b.id)?.position ?? 0n;

    return first < second ? -1 : first > second ? 1 : 0;
  });
  snapshot.historyBeforeItemId = snapshot.items[0]?.item?.itemId ?? snapshot.historyBeforeItemId;
}
