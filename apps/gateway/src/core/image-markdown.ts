import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { localMarkdownImages, type LocalMarkdownImage } from "@canopy/domain/markdown-images";
import { IMAGE_REPLY_LIMITS } from "@canopy/domain/image-replies";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { readImageMessage, imageTextHash, imageMessageItem, writeImageItem } from "../store/image-message.ts";
import { lockImageSource, type ImagePublication } from "../store/image-publications.ts";
import { Invalid, type CallSource, type ThreadRow } from "../store/index.ts";
import { coreState } from "./core-context.ts";
import { publishThreadImages } from "./image-publication.ts";
import type { GatewayCore } from "./core.ts";

/** Worker requests after message completion. All paths and offsets come from persisted source, never the worker. */
export async function importImageReply(core: GatewayCore, source: CallSource, caller: ThreadRow, itemId: string) {
  const actions = core[coreState].actions;
  const item = await actions.run(Effect.flatMap(SqlClient.SqlClient, (sql) => readImageMessage(sql, source, itemId)));

  if (item.content.case !== "agentMessage") throw new Invalid("Message unavailable.");
  const text = item.content.value.text;
  const references: LocalMarkdownImage[] = [];
  const manifest = { itemId, textHash: imageTextHash(text), references };
  const error = "Couldn't show these images. Open a file or ask the agent to send them again.";

  try {
    if (text.length > 100_000) throw new Invalid("This message is too long to import images. Use show_images.");
    references.push(...localMarkdownImages(text));

    if (!manifest.references.length) return { delivered: false, reason: "no_local_images" };

    if (manifest.references.length > IMAGE_REPLY_LIMITS.batchCount)
      throw new Invalid("Show up to 10 images in one message. Use show_images for selected screenshots.");

    return await publishThreadImages(
      core,
      source,
      caller,
      {
        images: manifest.references.map((ref) => ({ path: ref.path, alt: ref.alt })),
      },
      manifest,
    );
  } catch (cause) {
    const input: ImagePublication = {
      source,
      ownerId: caller.owner_user_id,
      workerId: caller.worker_id ?? "",
      count: 0,
      maxBytes: 0,
      requestHash: manifest.textHash,
      markdown: manifest,
    };

    const failed = await actions
      .run(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* lockImageSource(sql, input);
              const updated = yield* imageMessageItem(sql, source, manifest, [], error);

              return yield* writeImageItem(sql, source, updated);
            }),
          ),
        ),
      )
      .catch(() => undefined);

    if (failed)
      core.hub.publishThread(
        source.threadId,
        create(ui.ThreadUpdateSchema, {
          change: { case: "event", value: { seq: failed.seq, event: failed.event } },
        }),
      );
    throw cause;
  }
}
