import { create, type JsonValue } from "@bufbuild/protobuf";
import { GalleryImageSchema, ItemSchema, ItemStatus, type GalleryImage } from "@canopy/contracts";
import type { AgentBusArgs } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { PreparedAttachment } from "../attachments/prepare.ts";
import { AttachmentStore } from "./attachments.ts";
import { insertCall } from "./agent-bus-queries.ts";
import { lockImageSource, type ImageLease, type ImagePublication } from "./image-publications.ts";
import { Invalid } from "./store.ts";
import { imageMessageItem, writeImageItem } from "./image-message.ts";

/** Attachments, immutable transcript manifest, audit, quota accounting and receipt commit together. */
export function commitImageGallery(
  sql: SqlClient.SqlClient,
  input: ImagePublication,
  lease: ImageLease,
  args: AgentBusArgs["show_images"],
  files: readonly PreparedAttachment[],
  chargedBytes: number,
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* lockImageSource(sql, input);

      const held = yield* sql`SELECT call_id FROM thread_image_publications
        WHERE call_id=${input.source.callId}::uuid AND lease_token=${lease.token}::uuid
          AND state='reserved' AND expires_at>now() FOR UPDATE`;

      if (!held.length || chargedBytes <= 0 || chargedBytes > lease.budget)
        return yield* Effect.fail(new Invalid("The image transfer expired or exceeded its limit. Try again."));

      const images: GalleryImage[] = [];

      for (const [index, file] of files.entries()) {
        const attachment = yield* AttachmentStore.use((store) => store.create({ ownerUserId: input.ownerId, ...file }));
        yield* sql`UPDATE attachments SET thread_id=${input.source.threadId}::uuid,turn_id=${input.source.turnId}::uuid
          WHERE id=${attachment.id}::uuid AND owner_user_id=${input.ownerId}::uuid`;
        const description = args.images[index]!;
        images.push(
          create(GalleryImageSchema, {
            attachmentId: attachment.id,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: BigInt(file.data.length),
            width: file.width ?? 0,
            height: file.height ?? 0,
            hasThumbnail: Boolean(file.thumbnail),
            alt: description.alt,
            caption: description.caption ?? "",
            pair: description.pair ?? "",
            side: description.side ?? "",
            markdownStart: input.markdown?.references[index]?.start ?? 0,
            markdownEnd: input.markdown?.references[index]?.end ?? 0,
            sourcePath: input.markdown?.references[index]?.href ?? "",
          }),
        );
      }

      const item = input.markdown
        ? yield* imageMessageItem(sql, input.source, input.markdown, images)
        : create(ItemSchema, {
            itemId: `gallery-${input.source.callId}`,
            status: ItemStatus.COMPLETED,
            content: { case: "imageGallery", value: { images, caption: args.caption ?? "" } },
          });

      const itemId = item.itemId;
      const { seq, event } = yield* writeImageItem(sql, input.source, item);
      yield* sql`UPDATE thread_image_publications SET state='committed',size_bytes=${chargedBytes}
        WHERE call_id=${input.source.callId}::uuid AND lease_token=${lease.token}::uuid`;

      const result: JsonValue = {
        delivered: true,
        item_id: itemId,
        attachment_ids: images.map((image) => image.attachmentId),
      };

      yield* insertCall(sql, {
        source: input.source,
        tool: input.markdown ? "import_image_reply" : "show_images",
        args: input.markdown ? { item_id: input.markdown.itemId } : args,
        status: "completed",
        result,
      });
      yield* sql`INSERT INTO audit_log(id,actor_user_id,action,target_type,target_id,details)
        VALUES (${input.source.callId}::uuid,${input.ownerId}::uuid,'thread.show_images','thread',
          ${input.source.threadId}::uuid,${JSON.stringify({ count: files.length, size_bytes: chargedBytes, item_id: itemId })}::jsonb)`;

      return { result, seq, event };
    }),
  );
}
