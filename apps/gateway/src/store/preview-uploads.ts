import { createHash } from "node:crypto";
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ItemSchema } from "@canopy/contracts";
import { previewRefs } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { acceptsPreview, THREAD_BLOB_BYTES } from "../attachments/preview-policy.ts";
import { blobWriter, matchesBlob } from "./blob-writes.ts";

export interface PreviewSource {
  readonly workerId: string;
  readonly journalId: string;
}

export interface PreviewUpload extends PreviewSource {
  readonly threadId: string;
  readonly sha256: string;
  readonly data: Uint8Array;
  readonly mimeType: string;
}

const WORKER_FILES = 64;
const WORKER_BYTES = 64 * 1024 * 1024;
const DATABASE_FILES = 1024;
const DATABASE_BYTES = 512 * 1024 * 1024;

// Journal IDs are opaque. Keep established short IDs and bound the SQL index
// key for older clients using longer IDs; reserve the prefix to avoid aliasing.
function journalKey(id: string): string {
  if (id.length <= 128 && !id.startsWith("sha256:") && !id.includes("\0")) return id;

  return `sha256:${createHash("sha256").update(id).digest("hex")}`;
}

const verify = (sql: SqlClient.SqlClient, threadId: string, digest: string) =>
  sql`UPDATE thread_blobs SET verified=true WHERE thread_id=${threadId}::uuid AND sha256=${digest} AND NOT verified`;

/** Called only for a stored item, with its thread row locked. */
export const claimPreviews = (
  sql: SqlClient.SqlClient,
  source: PreviewSource,
  threadId: string,
  refs: readonly { sha256: string }[],
) =>
  Effect.gen(function* () {
    if (!refs.length) return;
    const journal = journalKey(source.journalId);

    for (const digest of [...new Set(refs.map((ref) => ref.sha256))].sort()) {
      yield* sql`INSERT INTO thread_blobs(thread_id,sha256,claimed_by_event)
        VALUES(${threadId}::uuid,${digest},true) ON CONFLICT (thread_id,sha256) DO UPDATE
        SET claimed_by_event=true WHERE NOT thread_blobs.verified AND NOT thread_blobs.claimed_by_event`;

      const rows = yield* sql<{ thread_scope: string }>`SELECT thread_scope FROM worker_preview_uploads
        WHERE worker_id=${source.workerId}::uuid AND journal_id=${journal}
          AND thread_scope IN (${threadId.toLowerCase()},'') AND sha256=${digest} AND expires_at>now()
          AND NOT EXISTS (SELECT 1 FROM thread_blobs WHERE thread_id=${threadId}::uuid AND sha256=${digest} AND verified)
        ORDER BY thread_scope DESC LIMIT 1 FOR UPDATE`;

      const upload = rows[0];

      if (!upload) continue;

      const key = sql`worker_id=${source.workerId}::uuid AND journal_id=${journal}
        AND thread_scope=${upload.thread_scope} AND sha256=${digest}`;

      yield* sql`INSERT INTO blobs(sha256,size_bytes,mime_type,data)
        SELECT sha256,size_bytes,mime_type,data FROM worker_preview_uploads WHERE ${key}
        ON CONFLICT (sha256) DO UPDATE SET data=excluded.data, size_bytes=excluded.size_bytes,
          mime_type=excluded.mime_type, storage_url=NULL
        WHERE blobs.data IS DISTINCT FROM excluded.data OR blobs.size_bytes<>excluded.size_bytes`;
      yield* verify(sql, threadId, digest);

      // Old workers sent shared bytes once per link. Their bounded proof can serve
      // a second authenticated event from the same journal until expiry.
      if (upload.thread_scope) yield* sql`DELETE FROM worker_preview_uploads WHERE ${key}`;
    }
  });

/** Replay restores only the committed projection, independently of the repeated frame's contents. */
export const recoverPreviews = (sql: SqlClient.SqlClient, source: PreviewSource, threadId: string, eventId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ content: JsonValue }>`SELECT i.content FROM thread_events e
      JOIN thread_items i ON i.thread_id=e.thread_id AND i.item_id=e.item_id
      WHERE e.thread_id=${threadId}::uuid AND e.event_id=${eventId}::uuid AND e.origin='worker'
        AND EXISTS (SELECT 1 FROM worker_preview_uploads u WHERE u.worker_id=${source.workerId}::uuid
          AND u.journal_id=${journalKey(source.journalId)} AND u.thread_scope IN (${threadId.toLowerCase()},'') AND u.expires_at>now())`;

    if (rows[0]) yield* claimPreviews(sql, source, threadId, previewRefs(fromJson(ItemSchema, rows[0].content)));
  });

/** Uploading bytes alone carries no read rights. */
export const stagePreview = (sql: SqlClient.SqlClient, input: PreviewUpload) =>
  Effect.gen(function* () {
    if (input.data.length > THREAD_BLOB_BYTES || !acceptsPreview(input.threadId, input.sha256, input.mimeType)) return;

    if (!matchesBlob(input.sha256, input.data)) return;

    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (input.threadId) {
          const thread = yield* sql`SELECT 1 FROM threads WHERE id=${input.threadId}::uuid
          AND worker_id=${input.workerId}::uuid AND deleted_at IS NULL FOR UPDATE`;

          if (!thread.length) return;

          // Use a fresh snapshot after acquiring the thread lock: a waiting event
          // transaction may just have committed its claim.
          const [claim] = yield* sql<{ verified: boolean; claimed_by_event: boolean }>`SELECT verified,claimed_by_event
          FROM thread_blobs WHERE thread_id=${input.threadId}::uuid AND sha256=${input.sha256} FOR UPDATE`;

          if (claim?.verified) return;

          if (claim?.claimed_by_event) {
            yield* blobWriter(sql)(input.sha256, input.data, input.mimeType);
            yield* verify(sql, input.threadId, input.sha256);

            return;
          }
        }

        yield* storePreview(sql, input);
      }),
    );
  });

function storePreview(sql: SqlClient.SqlClient, input: PreviewUpload) {
  return Effect.gen(function* () {
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('canopy.preview_upload_budget',0))`;
    yield* sql`DELETE FROM worker_preview_uploads WHERE ctid IN (
      SELECT ctid FROM worker_preview_uploads WHERE expires_at<=now() ORDER BY expires_at LIMIT 64 FOR UPDATE SKIP LOCKED)`;

    const [usage] = yield* sql<{ files: number; bytes: string; worker_files: number; worker_bytes: string }>`
      SELECT count(*)::int AS files, coalesce(sum(size_bytes),0)::text AS bytes,
             (count(*) FILTER (WHERE worker_id=${input.workerId}::uuid))::int AS worker_files,
             coalesce(sum(size_bytes) FILTER (WHERE worker_id=${input.workerId}::uuid),0)::text AS worker_bytes
        FROM worker_preview_uploads`;

    if (
      !usage ||
      usage.files >= DATABASE_FILES ||
      usage.worker_files >= WORKER_FILES ||
      Number(usage.bytes) + input.data.length > DATABASE_BYTES ||
      Number(usage.worker_bytes) + input.data.length > WORKER_BYTES
    )
      return;

    yield* sql`INSERT INTO worker_preview_uploads(worker_id,journal_id,thread_scope,sha256,mime_type,data)
      VALUES(${input.workerId}::uuid,${journalKey(input.journalId)},${input.threadId.toLowerCase()},${input.sha256},${input.mimeType},${input.data})
      ON CONFLICT DO NOTHING`;
  });
}
