import { createHash } from "node:crypto";
import { create, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { AgentBusArgs } from "@canopy/domain";
import { IMAGE_REPLY_LIMITS } from "@canopy/domain/image-replies";
import { THREAD_IMAGE_REPLIES_CAPABILITY } from "@canopy/domain/release/protocol";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { prepareAttachment, AttachmentRejected, type PreparedAttachment } from "../attachments/prepare.ts";
import { reserveImages, releaseImages, type ImageLease, type ImagePublication } from "../store/image-publications.ts";
import { commitImageGallery } from "../store/image-gallery.ts";
import { Invalid, type CallSource, type ThreadRow } from "../store/index.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { receiveThreadImage } from "./image-receive.ts";
import type { ImageMessageSource } from "../store/image-message.ts";

export async function publishThreadImages(
  core: GatewayCore,
  source: CallSource,
  caller: ThreadRow,
  args: AgentBusArgs["show_images"],
  markdown?: ImageMessageSource,
): Promise<JsonValue> {
  const workerId = caller.worker_id;
  const connection = workerId ? core.link.connections.get(workerId) : undefined;

  if (!workerId || !caller.cwd || !connection?.isOpen)
    throw new Invalid("This computer is offline. Reconnect it to show images.");

  if (!connection.hello.capabilities.includes(THREAD_IMAGE_REPLIES_CAPABILITY))
    throw new Invalid("Update this computer to show images in Canopy.");

  if (!/^[a-f0-9-]{36}$/i.test(source.turnId)) throw new Invalid("Images require a running turn.");
  const limits = await core.attachmentLimits;

  if (args.images.length > limits.maxFiles) throw new Invalid(`Show up to ${limits.maxFiles} images in one reply.`);

  const input: ImagePublication = {
    source,
    ownerId: caller.owner_user_id,
    workerId,
    requestHash: createHash("sha256").update(JSON.stringify({ args, markdown })).digest("hex"),
    count: args.images.length,
    maxBytes: Math.min(IMAGE_REPLY_LIMITS.batchBytes, limits.maxMessageBytes),
    ...(markdown && { markdown }),
  };

  const actions = core[coreState].actions;
  const waitingUntil = Date.now() + IMAGE_REPLY_LIMITS.transferMs + 10_000;
  let lease: ImageLease;

  for (;;) {
    const reserved = await actions.run(Effect.flatMap(SqlClient.SqlClient, (sql) => reserveImages(sql, input)));

    if (reserved.result !== undefined) return reserved.result;

    if (reserved.lease) {
      lease = reserved.lease;
      break;
    }

    if (Date.now() >= waitingUntil) throw new Invalid("Images are still being prepared. Try again.");
    await Bun.sleep(250);
  }

  try {
    const prepared: PreparedAttachment[] = [];
    let chargedBytes = 0;
    const roots = [caller.cwd];

    // Only this thread's attachment directory is eligible; no other scratch or attachment roots.
    if (!markdown && connection.hello.attachmentsRoot) {
      const separator = /^(win32|windows)$/.test(connection.hello.host?.os ?? "") ? "\\" : "/";
      roots.push(`${connection.hello.attachmentsRoot}${separator}${caller.id}`);
    }

    for (const image of args.images) {
      const maxBytes = Math.min(IMAGE_REPLY_LIMITS.fileBytes, limits.maxFileBytes, lease.budget - chargedBytes);
      const exportId = Bun.randomUUIDv7();

      const file = await receiveThreadImage(
        async (operation, offset) => {
          const remaining = lease.expiresAt.getTime() - Date.now();

          if (remaining <= 0 && operation !== "release") throw new Invalid("The image transfer expired. Try again.");

          const reply = await connection.sendCommand(
            {
              case: "exportThreadImage",
              value: {
                threadId: caller.id,
                turnId: source.turnId,
                exportId,
                path: image.path,
                roots,
                operation,
                offset,
                maxBytes: BigInt(Math.max(0, maxBytes)),
              },
            },
            Math.max(1, Math.min(IMAGE_REPLY_LIMITS.idleMs, remaining)),
          );

          if (!reply.ok || !reply.threadImageExport)
            throw new Invalid(reply.errorMessage || "Couldn't read this image. Check its path, then try again.");

          return reply.threadImageExport;
        },
        maxBytes,
        lease.expiresAt.getTime(),
      );

      const attachment = await prepareAttachment(
        file.name,
        file.data,
        { ...limits, maxFileBytes: maxBytes },
        { imageReply: true },
      );

      if (attachment.kind !== "image")
        throw new Invalid("Choose a supported raster image. SVG files stay downloadable files.");
      chargedBytes += Math.max(file.data.length, attachment.data.length);

      if (chargedBytes > lease.budget) throw new Invalid("These images exceed the reply limit. Show fewer images.");
      prepared.push(attachment);
    }

    const committed = await actions.run(
      Effect.flatMap(SqlClient.SqlClient, (sql) => commitImageGallery(sql, input, lease, args, prepared, chargedBytes)),
    );

    core.hub.publishThread(
      caller.id,
      create(ui.ThreadUpdateSchema, {
        change: { case: "event", value: { seq: committed.seq, event: committed.event } },
      }),
    );

    return committed.result;
  } catch (error) {
    if (error instanceof AttachmentRejected) throw new Invalid(error.message);
    throw error;
  } finally {
    await actions.run(Effect.flatMap(SqlClient.SqlClient, (sql) => releaseImages(sql, source.callId, lease.token)));
  }
}
