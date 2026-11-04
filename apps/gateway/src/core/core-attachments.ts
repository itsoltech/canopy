import { create } from "@bufbuild/protobuf";
import { ui, type BlobChunk, type FetchBlob } from "@canopy/contracts";
import { Effect } from "effect";
import { type WorkerConnection } from "../worker-link/index.ts";
import { attachmentPath, attachmentsNote, formatSize, withAttachmentsNote } from "@canopy/domain";
import { AttachmentRejected, prepareAttachment, sha256Hex } from "../attachments/prepare.ts";
import { AttachmentStore, toUiAttachment, type StoredAttachment } from "../store/attachments.ts";
import { NotFound } from "../store/index.ts";
import {
  BLOB_CHUNK_BYTES,
  coreState,
  describeError,
  InvalidError,
  MAX_PREVIEW_BYTES,
  PREVIEW_TYPES,
  type TurnInputJson,
} from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreLog } from "./core-broadcast.ts";

/**
 * The attachments of a new message: the user's, unsent, within the limits, for a worker that takes attachments.
 * `input` prepares the turn input: the platform note with each file's path on that worker, then the message.
 */
export async function coreMessageAttachments(
  hostContext: GatewayCore,
  ids: readonly string[],
  workerId: string,
): Promise<{ input(threadId: string, message: string): TurnInputJson }> {
  const limits = await hostContext.attachmentLimits;

  if (ids.length > limits.maxFiles)
    throw new InvalidError(`up to ${limits.maxFiles} files can be attached to one message`);
  const rows = await coreAttachments(hostContext, (s) => s.forMessage(hostContext[coreState].options.userId, ids));
  const total = rows.reduce((sum, r) => sum + Number(r.size_bytes), 0);

  if (total > limits.maxMessageBytes)
    throw new InvalidError(
      `the attachments are ${formatSize(total)}; a message can carry up to ${formatSize(limits.maxMessageBytes)}`,
    );
  const { root, os } = await coreAttachments(hostContext, (s) => s.workerRoot(workerId));

  if (!root)
    throw new InvalidError(
      "this thread's worker cannot take attachments yet (it has not connected since it was updated)",
    );

  return {
    input: (threadId, message) => {
      const attachments: StoredAttachment[] = rows.map((r) => ({
        id: r.id,
        name: r.name,
        mimeType: r.mime_type,
        kind: r.kind,
        sizeBytes: Number(r.size_bytes),
        ...(r.width && { width: r.width }),
        ...(r.height && { height: r.height }),
        sha256: r.sha256,
        hasThumbnail: r.thumb_sha256 !== null,
        path: attachmentPath(root, os, threadId, r.id, r.name),
      }));

      const note = attachmentsNote(attachments);

      return { text: withAttachmentsNote(note, message), note, message, attachments };
    },
  };
}

/** A preview chunk from a worker; the last one stores the blob once its hash and size check out. */
export async function coreReceiveBlob(
  hostContext: GatewayCore,
  connection: WorkerConnection,
  chunk: BlobChunk,
): Promise<void> {
  const uploads = hostContext[coreState].uploads.get(connection) ?? new Map();
  hostContext[coreState].uploads.set(connection, uploads);
  const upload = uploads.get(chunk.sha256) ?? { chunks: [], size: 0, mimeType: chunk.mimeType };

  if (BigInt(upload.size) !== chunk.offset) {
    // A gap (a lost or repeated chunk): start over from this one only if it is the first.
    uploads.delete(chunk.sha256);

    if (chunk.offset !== 0n) return;
    upload.chunks = [];
    upload.size = 0;
  }

  upload.chunks.push(chunk.data);
  upload.size += chunk.data.length;
  uploads.set(chunk.sha256, upload);

  if (upload.size > MAX_PREVIEW_BYTES) {
    uploads.delete(chunk.sha256);
    coreLog(
      hostContext,
      `preview ${chunk.sha256.slice(0, 12)} from worker ${connection.workerId} is over ${formatSize(MAX_PREVIEW_BYTES)}; dropped`,
    );

    return;
  }

  if (!chunk.last) return;
  uploads.delete(chunk.sha256);
  const data = Buffer.concat(upload.chunks);

  if (sha256Hex(data) !== chunk.sha256 || !PREVIEW_TYPES.has(upload.mimeType)) {
    coreLog(
      hostContext,
      `preview ${chunk.sha256.slice(0, 12)} from worker ${connection.workerId} does not match its hash or type; dropped`,
    );

    return;
  }

  await coreAttachments(hostContext, (s) => s.putBlob(chunk.sha256, new Uint8Array(data), upload.mimeType));
}

/** An attachment's bytes to the worker that runs its thread, in chunks (FetchBlob). */
export async function coreSendBlob(
  hostContext: GatewayCore,
  connection: WorkerConnection,
  request: FetchBlob,
): Promise<void> {
  const reply = (value: { offset?: bigint; data?: Uint8Array; last: boolean; error?: string }) => {
    try {
      connection.send({
        case: "blobChunk",
        value: { requestId: request.requestId, sha256: request.sha256, ...value },
      });

      return true;
    } catch {
      return false; // link closed: the worker asks again with the redelivered StartTurn
    }
  };

  let data: Uint8Array;

  try {
    data = await coreAttachments(hostContext, (s) =>
      s.workerBlob(connection.workerId, request.threadId, request.sha256),
    );
  } catch (error) {
    reply({
      last: true,
      error: error instanceof NotFound ? "attachment not found" : `attachment not readable: ${describeError(error)}`,
    });

    return;
  }

  for (let offset = 0; offset < data.length || offset === 0; offset += BLOB_CHUNK_BYTES) {
    const end = Math.min(offset + BLOB_CHUNK_BYTES, data.length);

    if (!reply({ offset: BigInt(offset), data: data.subarray(offset, end), last: end >= data.length })) return;

    if (end >= data.length) break;
  }
}

export function coreAttachments<A, E>(
  hostContext: GatewayCore,
  use: (store: AttachmentStore["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  return hostContext[coreState].actions.run(AttachmentStore.use(use));
}

export interface CoreAttachmentsMethods {
  uploadAttachment(name: string, data: Uint8Array): Promise<ui.Attachment>;
  getAttachment(attachmentId: string, thumbnail: boolean): Promise<ui.GetAttachmentResponse>;
  getThreadBlob(threadId: string, sha256: string): Promise<ui.GetThreadBlobResponse>;
}

export const coreAttachmentsMethods: CoreAttachmentsMethods = {
  /** An upload (docs/ui-api.md, "Załączniki"): typed by its content, images cleaned of metadata, owned by the user. */
  async uploadAttachment(this: GatewayCore, name: string, data: Uint8Array): Promise<ui.Attachment> {
    let prepared;

    try {
      prepared = await prepareAttachment(name, data, await this.attachmentLimits);
    } catch (error) {
      if (error instanceof AttachmentRejected) throw new InvalidError(error.message);
      throw error;
    }

    const row = await coreAttachments(this, (s) =>
      s.create({ ownerUserId: this[coreState].options.userId, ...prepared }),
    );

    return toUiAttachment(row);
  },

  async getAttachment(this: GatewayCore, attachmentId: string, thumbnail: boolean): Promise<ui.GetAttachmentResponse> {
    const row = await coreAttachments(this, (s) => s.owned(this[coreState].options.userId, attachmentId));
    const sha = thumbnail ? row.thumb_sha256 : row.sha256;

    if (!sha) throw new InvalidError("this attachment has no thumbnail");
    const blob = await coreAttachments(this, (s) => s.blob(sha));

    return create(ui.GetAttachmentResponseSchema, {
      attachment: toUiAttachment(row),
      data: blob.data,
      mimeType: blob.mimeType,
    });
  },

  async getThreadBlob(this: GatewayCore, threadId: string, sha256: string): Promise<ui.GetThreadBlobResponse> {
    const blob = await coreAttachments(this, (s) => s.threadBlob(this[coreState].options.userId, threadId, sha256));

    return create(ui.GetThreadBlobResponseSchema, { data: blob.data, mimeType: blob.mimeType });
  },
};
