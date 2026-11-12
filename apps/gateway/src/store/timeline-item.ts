import { create, fromJson } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ItemSchema, ui, type Item } from "@canopy/contracts";
import type { ItemRow } from "./thread-snapshot.ts";

export function decodeTimelineItem(row: ItemRow) {
  let item: Item;

  try {
    item = fromJson(ItemSchema, row.content, { ignoreUnknownFields: true });

    if (!item.itemId) item.itemId = row.item_id;

    if (!item.content.case)
      item.content = create(ItemSchema, {
        content: {
          case: "agentMessage",
          value: { text: "This item is unavailable in this version of Canopy." },
        },
      }).content;
  } catch {
    console.warn("Thread item decoding failed", { reason: "invalid_item" });
    item = create(ItemSchema, {
      itemId: row.item_id,
      content: {
        case: "agentMessage",
        value: { text: "This item is unavailable in this version of Canopy." },
      },
    });
  }

  return create(ui.TimelineItemSchema, {
    item,
    ...(row.content_sha && {
      contentRef: {
        sha256: row.content_sha,
        sizeBytes: BigInt(row.content_size ?? 0),
        typeName: ItemSchema.typeName,
        encoding: "json",
      },
    }),
    turnId: row.turn_id ?? "",
    firstSeq: BigInt(row.first_seq),
    lastSeq: BigInt(row.last_seq),
    inherited: row.inherited,
    fromThreadId: row.inherited ? row.thread_id : "",
    ...(row.completed_at && { completedAt: timestampFromDate(new Date(row.completed_at)) }),
  });
}
