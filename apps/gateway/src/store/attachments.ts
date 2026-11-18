import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { queryMethods } from "../diagnostics/query-context.ts";
import { Invalid, NotFound } from "./store.ts";
import { blobWriter, previewBlobWriters } from "./blob-writes.ts";

/**
 * Attachments and blobs (docs/ui-api.md, "Załączniki"; docs/data-model.md).
 *
 * - An upload stores its bytes (and an image's thumbnail) as content-addressed blobs and an `attachments` row owned
 *   by the user. Unbound until a message takes it (GatewayStore.enqueueTurn binds it to the thread and turn).
 * - The UI reads an attachment only as its owner, and a transcript blob (a preview the worker uploaded) only
 *   through a thread of its tree that references it (thread_blobs, written by Ingest).
 * - A worker reads only attachments of threads that run on it (FetchBlob).
 */

export interface AttachmentRow {
  id: string;
  owner_user_id: string;
  sha256: string;
  thumb_sha256: string | null;
  name: string;
  mime_type: string;
  kind: "image" | "video" | "file";
  duration_ms: number | string | null;
  size_bytes: bigint | number | string;
  width: number | null;
  height: number | null;
  thread_id: string | null;
  turn_id: string | null;
  bot_id: string | null;
  bot_turn_id: string | null;
}

/** An attachment as its turn keeps it (turns.input.attachments): what the UI shows and the worker writes. */
export interface StoredAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly kind: "image" | "video" | "file";
  readonly durationMs?: number;
  readonly sizeBytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly sha256: string;
  readonly hasThumbnail: boolean;
  /** Absolute path on the thread's worker. */
  readonly path: string;
}

export interface NewAttachment {
  readonly ownerUserId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly kind: "image" | "video" | "file";
  readonly durationMs?: number;
  readonly data: Uint8Array;
  readonly sha256: string;
  readonly width?: number;
  readonly height?: number;
  readonly thumbnail?: { readonly data: Uint8Array; readonly sha256: string };
}

type Fx<A> = Effect.Effect<A, SqlError.SqlError | NotFound | Invalid>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
export const THREAD_BLOB_BYTES = 8 * 1024 ** 2;

/**
 * The database driver refuses a server message over 16 MiB, while an attachment may be 20 MB, so a blob is read in
 * parts of this size (small enough even if bytea came back hex-encoded, two characters a byte).
 */
export const BLOB_PART_BYTES = 4 * 1024 ** 2;

/** What a blob read needs before its bytes: `stored` is null when the bytes are not in the database. */
interface BlobMeta {
  readonly mime_type: string;
  readonly size_bytes: number | string | bigint;
  readonly stored: number | string | null;
}

export class AttachmentStore extends Context.Service<
  AttachmentStore,
  {
    create(input: NewAttachment): Fx<AttachmentRow>;
    /** The owner's attachment; anyone else's is "not found". */
    owned(ownerUserId: string, attachmentId: string): Fx<AttachmentRow>;
    /** Attachments a new message may take: the owner's, not yet sent, in the order given. */
    forMessage(ownerUserId: string, ids: readonly string[]): Fx<AttachmentRow[]>;
    blob(
      sha256: string,
      maxBytes?: number,
      offset?: number,
    ): Fx<{ data: Uint8Array; mimeType: string; totalSize: bigint }>;
    /** Stores a blob (idempotent: the same content is the same blob). */
    putBlob(sha256: string, data: Uint8Array, mimeType: string): Fx<void>;
    /** A preview is bound before its event; deleted-thread uploads cannot recreate retained content. */
    putThreadBlob(workerId: string, threadId: string, sha256: string, data: Uint8Array, mimeType: string): Fx<void>;
    /** Older workers do not identify preview ownership; keep these hashes out of retention. */
    putUnscopedBlob(sha256: string, data: Uint8Array, mimeType: string): Fx<void>;
    /** A transcript blob the owner may read through this thread (or another thread of its tree). */
    threadBlob(ownerUserId: string, threadId: string, sha256: string): Fx<{ data: Uint8Array; mimeType: string }>;
    /** An attachment's bytes for a worker: only of a thread that runs on that worker. */
    workerBlob(workerId: string, threadId: string, sha256: string): Fx<Uint8Array>;
    workerBotBlob(workerId: string, botId: string, turnId: string, sha256: string): Fx<Uint8Array>;
    /** Where the worker keeps attachments (Hello.attachments_root) and its OS; root empty = no attachment support. */
    workerRoot(workerId: string): Fx<{ root: string; os: string }>;
  }
>()("canopy/gateway/AttachmentStore") {
  static readonly layer = Layer.effect(
    AttachmentStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const putBlob = blobWriter(sql);

      /** Bytes `[offset, offset + maxBytes)` of a blob found by `rows` (its metadata), read in parts. */
      const readBlob = (rows: readonly BlobMeta[], what: string, sha256: string, maxBytes?: number, offset = 0) =>
        Effect.gen(function* () {
          const row = rows[0];

          // Blobs moved to object storage (storage_url) are not served yet.
          if (!row || row.stored === null) return yield* Effect.fail(new NotFound(`${what} not found`));
          const length = Math.max(0, Math.min(maxBytes ?? Infinity, Number(row.stored) - offset));
          const data = new Uint8Array(length);
          let read = 0;

          while (read < length) {
            const parts = yield* sql<{ data: Uint8Array | null }>`
              SELECT substring(data FROM ${offset + read + 1}::integer FOR ${Math.min(BLOB_PART_BYTES, length - read)}::integer) AS data
                FROM blobs WHERE sha256 = ${sha256}`;

            const part = parts[0]?.data;

            if (!part?.length) return yield* Effect.fail(new NotFound(`${what} not found`));
            data.set(part, read);
            read += part.length;
          }

          return { data, mimeType: row.mime_type, totalSize: BigInt(row.size_bytes) };
        });

      const store = AttachmentStore.of({
        putBlob,
        ...previewBlobWriters(sql, putBlob),

        create: (input) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* putBlob(input.sha256, input.data, input.mimeType);

              if (input.thumbnail) yield* putBlob(input.thumbnail.sha256, input.thumbnail.data, "image/webp");

              const rows = yield* sql<AttachmentRow>`
                INSERT INTO attachments (id, owner_user_id, sha256, thumb_sha256, name, mime_type, kind, size_bytes, width, height, duration_ms)
                VALUES (${Bun.randomUUIDv7()}::uuid, ${input.ownerUserId}::uuid, ${input.sha256}, ${input.thumbnail?.sha256 ?? null}, ${input.name},
                        ${input.mimeType}, ${input.kind}, ${input.data.length}, ${input.width ?? null}, ${input.height ?? null}, ${input.durationMs ?? null})
                RETURNING *`;

              return rows[0]!;
            }),
          ),

        owned: (ownerUserId, attachmentId) =>
          UUID.test(attachmentId)
            ? sql<AttachmentRow>`SELECT * FROM attachments WHERE id = ${attachmentId}::uuid AND owner_user_id = ${ownerUserId}::uuid`.pipe(
                Effect.flatMap((rows) =>
                  rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("attachment not found")),
                ),
              )
            : Effect.fail(new NotFound("attachment not found")),

        forMessage: (ownerUserId, ids) =>
          Effect.gen(function* () {
            if (ids.length === 0) return [];

            if (new Set(ids).size !== ids.length)
              return yield* Effect.fail(new Invalid("an attachment is listed twice"));

            if (!ids.every((id) => UUID.test(id))) return yield* Effect.fail(new Invalid("unknown attachment"));

            const rows = yield* sql<AttachmentRow>`
              SELECT * FROM attachments WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[]) AND owner_user_id = ${ownerUserId}::uuid`;

            const byId = new Map(rows.map((r) => [r.id, r]));
            const ordered: AttachmentRow[] = [];

            for (const id of ids) {
              const row = byId.get(id);

              if (!row) return yield* Effect.fail(new Invalid("unknown attachment (upload it again)"));

              if (row.thread_id || row.bot_id)
                return yield* Effect.fail(new Invalid(`${row.name} was already sent with another message`));
              ordered.push(row);
            }

            return ordered;
          }),

        blob: (sha256, maxBytes, offset = 0) =>
          SHA256.test(sha256)
            ? sql<BlobMeta>`SELECT octet_length(data) AS stored, mime_type, size_bytes FROM blobs WHERE sha256 = ${sha256}`.pipe(
                Effect.flatMap((rows) => readBlob(rows, "blob", sha256, maxBytes, offset)),
              )
            : Effect.fail(new NotFound("blob not found")),

        threadBlob: (ownerUserId, threadId, sha256) =>
          UUID.test(threadId) && SHA256.test(sha256)
            ? sql<BlobMeta>`
                SELECT octet_length(b.data) AS stored, b.mime_type, b.size_bytes FROM blobs b
                 WHERE b.sha256 = ${sha256}
                   AND EXISTS (
                     SELECT 1 FROM thread_blobs tb JOIN threads t ON t.id = tb.thread_id
                      WHERE tb.sha256 = b.sha256 AND t.owner_user_id = ${ownerUserId}::uuid AND t.deleted_at IS NULL
                        AND t.root_thread_id = (SELECT root_thread_id FROM threads WHERE id = ${threadId}::uuid AND owner_user_id = ${ownerUserId}::uuid AND deleted_at IS NULL))`.pipe(
                Effect.flatMap((rows): Fx<{ data: Uint8Array; mimeType: string }> =>
                  rows[0] && Number(rows[0].size_bytes) > THREAD_BLOB_BYTES
                    ? Effect.fail(new Invalid("This content exceeds the 8 MB viewing limit."))
                    : readBlob(rows, "content", sha256),
                ),
              )
            : Effect.fail(new NotFound("content not found")),

        workerBlob: (workerId, threadId, sha256) =>
          UUID.test(threadId) && SHA256.test(sha256)
            ? sql<BlobMeta>`
                SELECT octet_length(b.data) AS stored, b.mime_type, b.size_bytes FROM blobs b
                 WHERE b.sha256 = ${sha256}
                   AND EXISTS (SELECT 1 FROM attachments a JOIN threads t ON t.id = a.thread_id
                                WHERE a.sha256 = b.sha256 AND a.thread_id = ${threadId}::uuid AND t.worker_id = ${workerId}::uuid AND t.deleted_at IS NULL)`.pipe(
                Effect.flatMap((rows) => readBlob(rows, "attachment", sha256)),
                Effect.map((blob) => blob.data),
              )
            : Effect.fail(new NotFound("attachment not found")),

        workerBotBlob: (workerId, botId, turnId, sha256) =>
          UUID.test(botId) && UUID.test(turnId) && SHA256.test(sha256)
            ? sql<BlobMeta>`
                SELECT octet_length(bl.data) AS stored, bl.mime_type, bl.size_bytes FROM blobs bl WHERE bl.sha256=${sha256}
                AND EXISTS (SELECT 1 FROM attachments a JOIN bots b ON b.id=a.bot_id
                  JOIN bot_harness_turns h ON h.bot_id=b.id JOIN bot_turns t ON t.id=h.turn_id
                  JOIN bot_turns input ON input.id=a.bot_turn_id AND input.bot_id=b.id
                  WHERE input.conversation_id IS NOT DISTINCT FROM t.conversation_id AND a.sha256=bl.sha256 AND b.id=${botId}::uuid
                    AND a.owner_user_id=b.owner_user_id AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL
                    AND h.turn_id=${turnId}::uuid AND h.worker_id=${workerId}::uuid
                    AND h.outcome IS NULL AND t.status='running')`.pipe(
                Effect.flatMap((rows) => readBlob(rows, "attachment", sha256)),
                Effect.map((blob) => blob.data),
              )
            : Effect.fail(new NotFound("attachment not found")),

        workerRoot: (workerId) =>
          sql<{ root: string | null; os: string | null }>`
            SELECT capabilities->>'attachmentsRoot' AS root, os FROM workers WHERE id = ${workerId}::uuid`.pipe(
            Effect.map((rows) => ({ root: rows[0]?.root ?? "", os: rows[0]?.os ?? "" })),
          ),
      });

      return queryMethods("attachments.store", store);
    }),
  );
}

export function toUiAttachment(row: AttachmentRow | StoredAttachment): ui.Attachment {
  if ("owner_user_id" in row) {
    return create(ui.AttachmentSchema, {
      id: row.id,
      name: row.name,
      mimeType: row.mime_type,
      kind: row.kind,
      sizeBytes: BigInt(row.size_bytes),
      width: row.width ?? 0,
      height: row.height ?? 0,
      sha256: row.sha256,
      hasThumbnail: row.thumb_sha256 !== null,
      durationMs: Number(row.duration_ms ?? 0),
    });
  }

  return create(ui.AttachmentSchema, {
    id: row.id,
    name: row.name,
    mimeType: row.mimeType,
    kind: row.kind,
    sizeBytes: BigInt(row.sizeBytes),
    width: row.width ?? 0,
    height: row.height ?? 0,
    sha256: row.sha256,
    hasThumbnail: row.hasThumbnail,
    durationMs: row.durationMs ?? 0,
  });
}
