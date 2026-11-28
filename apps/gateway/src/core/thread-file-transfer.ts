import type { JsonValue } from "@bufbuild/protobuf";
import { IMAGE_REPLY_LIMITS } from "@canopy/domain/image-replies";
import { THREAD_IMAGE_REPLIES_CAPABILITY } from "@canopy/domain/release/protocol";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { prepareAttachment, AttachmentRejected, type PreparedAttachment } from "../attachments/prepare.ts";
import { reserveImages, releaseImages, type ImageLease, type ImagePublication } from "../store/image-publications.ts";
import type { ImageMessageSource } from "../store/image-message.ts";
import { Invalid, type CallSource, type ThreadRow } from "../store/index.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { receiveThreadImage } from "./image-receive.ts";

interface ThreadFileRequest {
  media: "image" | "video" | "file";
  paths: readonly string[];
  hash: string;
  markdown?: ImageMessageSource | undefined;
}

export interface ThreadFileTransfer {
  input: ImagePublication;
  lease: ImageLease;
  files: readonly PreparedAttachment[];
  chargedBytes: number;
}

/** Read selected files from pinned worker roots. The caller commits the reservation with its durable result. */
export async function transferThreadFiles(
  core: GatewayCore,
  source: CallSource,
  caller: ThreadRow,
  request: ThreadFileRequest,
  commit: (transfer: ThreadFileTransfer) => Promise<JsonValue>,
): Promise<JsonValue> {
  const { media, paths, markdown } = request;
  const workerId = caller.worker_id;
  const connection = workerId ? core.link.connections.get(workerId) : undefined;
  const action = media === "file" ? "transfer attachments" : `show ${media}s`;

  if (!workerId || !caller.cwd || !connection?.isOpen)
    throw new Invalid(`This computer is offline. Reconnect it to ${action}.`);

  if (!connection.hello.capabilities.includes(THREAD_IMAGE_REPLIES_CAPABILITY))
    throw new Invalid(`Update this computer to ${action} in Canopy.`);

  if (!/^[a-f0-9-]{36}$/i.test(source.turnId)) throw new Invalid("Transferring attachments requires a running turn.");
  const limits = await core.attachmentLimits;

  if (paths.length > limits.maxFiles) throw new Invalid(`Choose up to ${limits.maxFiles} attachments per message.`);

  const input: ImagePublication = {
    source,
    ownerId: caller.owner_user_id,
    workerId,
    requestHash: request.hash,
    count: paths.length,
    maxBytes: Math.min(
      media === "video" ? Math.min(IMAGE_REPLY_LIMITS.fileBytes, limits.maxFileBytes) : IMAGE_REPLY_LIMITS.batchBytes,
      limits.maxMessageBytes,
    ),
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

    if (Date.now() >= waitingUntil) throw new Invalid("Attachments are still being prepared. Try again.");
    await Bun.sleep(250);
  }

  try {
    const prepared: PreparedAttachment[] = [];
    let chargedBytes = 0;
    const roots = [caller.cwd];
    const windows = /^(win32|windows)$/.test(connection.hello.host?.os ?? "");

    const allowLocalTemp =
      media !== "file" &&
      !markdown &&
      core.role === "desktop" &&
      windows &&
      connection.hello.capabilities.includes("desktop_bundled");

    // Only this thread's attachment directory is eligible; no other scratch or attachment roots.
    if (!markdown && media !== "file" && connection.hello.attachmentsRoot) {
      const separator = windows ? "\\" : "/";
      roots.push(`${connection.hello.attachmentsRoot}${separator}${caller.id}`);
    }

    for (const path of paths) {
      const maxBytes = Math.min(IMAGE_REPLY_LIMITS.fileBytes, limits.maxFileBytes, lease.budget - chargedBytes);
      const exportId = Bun.randomUUIDv7();

      const file = await receiveThreadImage(
        async (operation, offset) => {
          const remaining = lease.expiresAt.getTime() - Date.now();

          if (remaining <= 0 && operation !== "release") throw new Invalid(`The ${media} transfer expired. Try again.`);

          const reply = await connection.sendCommand(
            {
              case: "exportThreadImage",
              value: {
                threadId: caller.id,
                turnId: source.turnId,
                exportId,
                path,
                roots,
                operation,
                offset,
                maxBytes: BigInt(Math.max(0, maxBytes)),
                allowLocalTemp,
              },
            },
            Math.max(1, Math.min(IMAGE_REPLY_LIMITS.idleMs, remaining)),
          );

          if (!reply.ok || !reply.threadImageExport)
            throw new Invalid(reply.errorMessage || `Couldn't read this ${media}. Check its path, then try again.`);

          return reply.threadImageExport;
        },
        maxBytes,
        lease.expiresAt.getTime(),
        media,
      );

      const attachment = await prepareAttachment(
        file.name,
        file.data,
        { ...limits, maxFileBytes: maxBytes },
        media === "file" ? {} : { replyKind: media },
      );

      if (media === "image" && attachment.kind !== "image")
        throw new Invalid("Choose a supported raster image. SVG files stay downloadable files.");
      chargedBytes += Math.max(file.data.length, attachment.data.length);

      if (chargedBytes > lease.budget) throw new Invalid("These attachments exceed the message size limit.");
      prepared.push(attachment);
    }

    return await commit({ input, lease, files: prepared, chargedBytes });
  } catch (error) {
    if (error instanceof AttachmentRejected) throw new Invalid(error.message);
    throw error;
  } finally {
    await actions.run(Effect.flatMap(SqlClient.SqlClient, (sql) => releaseImages(sql, source.callId, lease.token)));
  }
}
