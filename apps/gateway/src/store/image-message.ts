import { createHash } from "node:crypto";
import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { ItemSchema, ThreadEventSchema, type GalleryImage, type Item } from "@canopy/contracts";
import type { LocalMarkdownImage } from "@canopy/domain/markdown-images";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { CallSource } from "./agent-bus-types.ts";
import { Invalid } from "./store.ts";

export interface ImageMessageSource {
  readonly itemId: string;
  readonly textHash: string;
  readonly references: readonly LocalMarkdownImage[];
}

export const imageTextHash = (text: string) => createHash("sha256").update(text).digest("hex");

export function readImageMessage(sql: SqlClient.SqlClient, source: CallSource, itemId: string, hash?: string) {
  return Effect.gen(function* () {
    const rows = yield* sql<{ content: JsonValue }>`SELECT content FROM thread_items
      WHERE thread_id=${source.threadId}::uuid AND turn_id=${source.turnId}::uuid
        AND item_id=${itemId} AND type='agent_message' AND status='completed' FOR UPDATE`;

    const item = rows[0] ? fromJson(ItemSchema, rows[0].content) : undefined;

    if (item?.content.case !== "agentMessage" || (hash && imageTextHash(item.content.value.text) !== hash))
      return yield* Effect.fail(new Invalid("This message changed or is unavailable. Send the images again."));

    return item;
  });
}

export function imageMessageItem(
  sql: SqlClient.SqlClient,
  source: CallSource,
  manifest: ImageMessageSource,
  images: GalleryImage[],
  error = "",
) {
  return Effect.gen(function* () {
    const item = yield* readImageMessage(sql, source, manifest.itemId, manifest.textHash);

    if (item.content.case !== "agentMessage") return yield* Effect.fail(new Invalid("Message unavailable."));
    item.content.value.images = images;
    item.content.value.imageError = error;

    return item;
  });
}

/** Called while holding the thread row; update only this item, preserving its first sequence. */
export function writeImageItem(sql: SqlClient.SqlClient, source: CallSource, item: Item) {
  return Effect.gen(function* () {
    const locked = yield* sql<{ last_seq: string }>`SELECT last_seq FROM threads WHERE id=${source.threadId}::uuid`;
    const seq = BigInt(locked[0]!.last_seq) + 1n;

    const event = create(ThreadEventSchema, {
      eventId: Bun.randomUUIDv7(),
      threadId: source.threadId,
      turnId: source.turnId,
      occurredAt: timestampNow(),
      body: { case: "itemCompleted", value: { item } },
    });

    yield* sql`INSERT INTO thread_events(thread_id,seq,event_id,origin,turn_id,kind,item_id,payload,occurred_at)
      VALUES (${source.threadId}::uuid,${seq},${event.eventId}::uuid,'gateway',${source.turnId}::uuid,
        'item_completed',${item.itemId},${JSON.stringify(toJson(ThreadEventSchema, event))}::jsonb,now())`;
    yield* sql`INSERT INTO thread_items(thread_id,item_id,turn_id,type,status,content,first_seq,last_seq)
      VALUES (${source.threadId}::uuid,${item.itemId},${source.turnId}::uuid,
        ${item.content.case === "imageGallery" ? "image_gallery" : "agent_message"},'completed',
        ${JSON.stringify(toJson(ItemSchema, item))}::jsonb,${seq},${seq})
      ON CONFLICT (thread_id,item_id) DO UPDATE SET content=excluded.content,last_seq=excluded.last_seq`;
    yield* sql`UPDATE threads SET last_seq=${seq} WHERE id=${source.threadId}::uuid`;

    return { seq, event };
  });
}
