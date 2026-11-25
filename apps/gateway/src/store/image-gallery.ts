import { create, type JsonValue } from "@bufbuild/protobuf";
import { GalleryImageSchema, ItemSchema, ItemStatus, type GalleryImage } from "@canopy/contracts";
import type { AgentBusArgs } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { PreparedAttachment } from "../attachments/prepare.ts";
import { AttachmentStore, toUiAttachment } from "./attachments.ts";
import { insertCall } from "./agent-bus-queries.ts";
import { lockImageSource, type ImageLease, type ImagePublication } from "./image-publications.ts";
import { Invalid } from "./store.ts";
import { imageMessageItem, writeMediaItem, type ImageMessageSource } from "./image-message.ts";

export type ThreadMediaRequest =
  | { tool: "show_images"; args: AgentBusArgs["show_images"]; markdown?: ImageMessageSource }
  | { tool: "show_video"; args: AgentBusArgs["show_video"] };

/** Attachments, immutable transcript manifest, audit, quota accounting and receipt commit together. */
export function commitThreadMedia(
  sql: SqlClient.SqlClient,
  input: ImagePublication,
  lease: ImageLease,
  request: ThreadMediaRequest,
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
        return yield* Effect.fail(new Invalid("The attachment transfer expired or exceeded its limit. Try again."));

      const attachments = yield* Effect.forEach(files, (file) => bindAttachment(sql, input, file));

      const item =
        request.tool === "show_video"
          ? create(ItemSchema, {
              itemId: `published-video-${input.source.callId}`,
              status: ItemStatus.COMPLETED,
              content: {
                case: "publishedVideo",
                value: { attachment: attachments[0], caption: request.args.caption ?? "" },
              },
            })
          : yield* galleryItem(sql, input.source, request, attachments);

      const itemId = item.itemId;
      const { seq, event } = yield* writeMediaItem(sql, input.source, item);
      yield* sql`UPDATE thread_image_publications SET state='committed',size_bytes=${chargedBytes}
        WHERE call_id=${input.source.callId}::uuid AND lease_token=${lease.token}::uuid`;

      const result: JsonValue = {
        delivered: true,
        item_id: itemId,
        attachment_ids: attachments.map((attachment) => attachment.id),
      };

      const tool = input.markdown ? "import_image_reply" : request.tool;
      yield* insertCall(sql, {
        source: input.source,
        tool,
        args: input.markdown ? { item_id: input.markdown.itemId } : request.args,
        status: "completed",
        result,
      });
      yield* sql`INSERT INTO audit_log(id,actor_user_id,action,target_type,target_id,details)
        VALUES (${input.source.callId}::uuid,${input.ownerId}::uuid,${`thread.${request.tool}`},'thread',
          ${input.source.threadId}::uuid,${JSON.stringify({ count: files.length, size_bytes: chargedBytes, item_id: itemId })}::jsonb)`;

      return { result, seq, event };
    }),
  );
}

function bindAttachment(sql: SqlClient.SqlClient, input: ImagePublication, file: PreparedAttachment) {
  return Effect.gen(function* () {
    const attachment = yield* AttachmentStore.use((store) => store.create({ ownerUserId: input.ownerId, ...file }));
    yield* sql`UPDATE attachments SET thread_id=${input.source.threadId}::uuid,turn_id=${input.source.turnId}::uuid
      WHERE id=${attachment.id}::uuid AND owner_user_id=${input.ownerId}::uuid`;

    return toUiAttachment(attachment);
  });
}

function galleryItem(
  sql: SqlClient.SqlClient,
  source: ImagePublication["source"],
  { args, markdown }: Extract<ThreadMediaRequest, { tool: "show_images" }>,
  attachments: readonly ReturnType<typeof toUiAttachment>[],
) {
  const images: GalleryImage[] = attachments.map((attachment, index) => {
    const description = args.images[index]!;
    const reference = markdown?.references[index];

    return create(GalleryImageSchema, {
      attachmentId: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      width: attachment.width,
      height: attachment.height,
      hasThumbnail: attachment.hasThumbnail,
      alt: description.alt,
      caption: description.caption ?? "",
      pair: description.pair ?? "",
      side: description.side ?? "",
      markdownStart: reference?.start ?? 0,
      markdownEnd: reference?.end ?? 0,
      sourcePath: reference?.href ?? "",
    });
  });

  return markdown
    ? imageMessageItem(sql, source, markdown, images)
    : Effect.succeed(
        create(ItemSchema, {
          itemId: `gallery-${source.callId}`,
          status: ItemStatus.COMPLETED,
          content: { case: "imageGallery", value: { images, caption: args.caption ?? "" } },
        }),
      );
}
