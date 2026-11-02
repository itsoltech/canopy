import { create } from "@bufbuild/protobuf";
import { ui } from "@open-agents/contracts";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { Invalid, NotFound } from "./store.ts";

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
  kind: "image" | "file";
  size_bytes: bigint | number | string;
  width: number | null;
  height: number | null;
  thread_id: string | null;
  turn_id: string | null;
}

/** An attachment as its turn keeps it (turns.input.attachments): what the UI shows and the worker writes. */
export interface StoredAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly kind: "image" | "file";
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
  readonly kind: "image" | "file";
  readonly data: Uint8Array;
  readonly sha256: string;
  readonly width?: number;
  readonly height?: number;
  readonly thumbnail?: { readonly data: Uint8Array; readonly sha256: string };
}

type Fx<A> = Effect.Effect<A, SqlError.SqlError | NotFound | Invalid>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export class AttachmentStore extends Context.Service<
  AttachmentStore,
  {
    create(input: NewAttachment): Fx<AttachmentRow>;
    /** The owner's attachment; anyone else's is "not found". */
    owned(ownerUserId: string, attachmentId: string): Fx<AttachmentRow>;
    /** Attachments a new message may take: the owner's, not yet sent, in the order given. */
    forMessage(ownerUserId: string, ids: readonly string[]): Fx<AttachmentRow[]>;
    blob(sha256: string): Fx<{ data: Uint8Array; mimeType: string }>;
    /** Stores a blob (idempotent: the same content is the same blob). */
    putBlob(sha256: string, data: Uint8Array, mimeType: string): Fx<void>;
    /** A transcript blob the owner may read through this thread (or another thread of its tree). */
    threadBlob(ownerUserId: string, threadId: string, sha256: string): Fx<{ data: Uint8Array; mimeType: string }>;
    /** An attachment's bytes for a worker: only of a thread that runs on that worker. */
    workerBlob(workerId: string, threadId: string, sha256: string): Fx<Uint8Array>;
    /** Where the worker keeps attachments (Hello.attachments_root) and its OS; root empty = no attachment support. */
    workerRoot(workerId: string): Fx<{ root: string; os: string }>;
  }
>()("open-agents/gateway/AttachmentStore") {
  static readonly layer = Layer.effect(
    AttachmentStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const putBlob = (sha256: string, data: Uint8Array, mimeType: string) =>
        sql`INSERT INTO blobs (sha256, size_bytes, mime_type, data) VALUES (${sha256}, ${data.length}, ${mimeType}, ${data})
            ON CONFLICT (sha256) DO NOTHING`.pipe(Effect.asVoid);

      const readBlob = (rows: readonly { data: Uint8Array | null; mime_type: string }[], what: string) => {
        const row = rows[0];
        // Blobs moved to object storage (storage_url) are not served yet.
        if (!row?.data) return Effect.fail(new NotFound(`${what} not found`));
        return Effect.succeed({ data: new Uint8Array(row.data), mimeType: row.mime_type });
      };

      return AttachmentStore.of({
        putBlob,

        create: (input) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* putBlob(input.sha256, input.data, input.mimeType);
              if (input.thumbnail) yield* putBlob(input.thumbnail.sha256, input.thumbnail.data, "image/webp");
              const rows = yield* sql<AttachmentRow>`
                INSERT INTO attachments (id, owner_user_id, sha256, thumb_sha256, name, mime_type, kind, size_bytes, width, height)
                VALUES (${Bun.randomUUIDv7()}::uuid, ${input.ownerUserId}::uuid, ${input.sha256}, ${input.thumbnail?.sha256 ?? null}, ${input.name},
                        ${input.mimeType}, ${input.kind}, ${input.data.length}, ${input.width ?? null}, ${input.height ?? null})
                RETURNING *`;
              return rows[0]!;
            }),
          ),

        owned: (ownerUserId, attachmentId) =>
          UUID.test(attachmentId)
            ? sql<AttachmentRow>`SELECT * FROM attachments WHERE id = ${attachmentId}::uuid AND owner_user_id = ${ownerUserId}::uuid`.pipe(
                Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("attachment not found")))),
              )
            : Effect.fail(new NotFound("attachment not found")),

        forMessage: (ownerUserId, ids) =>
          Effect.gen(function* () {
            if (ids.length === 0) return [];
            if (new Set(ids).size !== ids.length) return yield* Effect.fail(new Invalid("an attachment is listed twice"));
            if (!ids.every((id) => UUID.test(id))) return yield* Effect.fail(new Invalid("unknown attachment"));
            const rows = yield* sql<AttachmentRow>`
              SELECT * FROM attachments WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[]) AND owner_user_id = ${ownerUserId}::uuid`;
            const byId = new Map(rows.map((r) => [r.id, r]));
            const ordered: AttachmentRow[] = [];
            for (const id of ids) {
              const row = byId.get(id);
              if (!row) return yield* Effect.fail(new Invalid("unknown attachment (upload it again)"));
              if (row.thread_id) return yield* Effect.fail(new Invalid(`${row.name} was already sent with another message`));
              ordered.push(row);
            }
            return ordered;
          }),

        blob: (sha256) =>
          SHA256.test(sha256)
            ? sql<{ data: Uint8Array | null; mime_type: string }>`SELECT data, mime_type FROM blobs WHERE sha256 = ${sha256}`.pipe(
                Effect.flatMap((rows) => readBlob(rows, "blob")),
              )
            : Effect.fail(new NotFound("blob not found")),

        threadBlob: (ownerUserId, threadId, sha256) =>
          UUID.test(threadId) && SHA256.test(sha256)
            ? sql<{ data: Uint8Array | null; mime_type: string }>`
                SELECT b.data, b.mime_type FROM blobs b
                 WHERE b.sha256 = ${sha256}
                   AND EXISTS (
                     SELECT 1 FROM thread_blobs tb JOIN threads t ON t.id = tb.thread_id
                      WHERE tb.sha256 = b.sha256 AND t.owner_user_id = ${ownerUserId}::uuid AND t.deleted_at IS NULL
                        AND t.root_thread_id = (SELECT root_thread_id FROM threads WHERE id = ${threadId}::uuid AND owner_user_id = ${ownerUserId}::uuid AND deleted_at IS NULL))`.pipe(
                Effect.flatMap((rows) => readBlob(rows, "image")),
              )
            : Effect.fail(new NotFound("image not found")),

        workerBlob: (workerId, threadId, sha256) =>
          UUID.test(threadId) && SHA256.test(sha256)
            ? sql<{ data: Uint8Array | null; mime_type: string }>`
                SELECT b.data, b.mime_type FROM blobs b
                 WHERE b.sha256 = ${sha256}
                   AND EXISTS (SELECT 1 FROM attachments a JOIN threads t ON t.id = a.thread_id
                                WHERE a.sha256 = b.sha256 AND a.thread_id = ${threadId}::uuid AND t.worker_id = ${workerId}::uuid AND t.deleted_at IS NULL)`.pipe(
                Effect.flatMap((rows) => readBlob(rows, "attachment")),
                Effect.map((blob) => blob.data),
              )
            : Effect.fail(new NotFound("attachment not found")),

        workerRoot: (workerId) =>
          sql<{ root: string | null; os: string | null }>`
            SELECT capabilities->>'attachmentsRoot' AS root, os FROM workers WHERE id = ${workerId}::uuid`.pipe(
            Effect.map((rows) => ({ root: rows[0]?.root ?? "", os: rows[0]?.os ?? "" })),
          ),
      });
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
  });
}
