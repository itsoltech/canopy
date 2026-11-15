import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";

type BlobWriter = (sha256: string, data: Uint8Array, mimeType: string) => Effect.Effect<void, SqlError.SqlError>;

export const blobWriter =
  (sql: SqlClient.SqlClient): BlobWriter =>
  (sha256, data, mimeType) =>
    sql`INSERT INTO blobs (sha256, size_bytes, mime_type, data) VALUES (${sha256}, ${data.length}, ${mimeType}, ${data})
    ON CONFLICT (sha256) DO NOTHING`.pipe(Effect.asVoid);

/** Preview ownership and bytes commit together, before the timeline event can arrive. */
export function previewBlobWriters(sql: SqlClient.SqlClient, putBlob: BlobWriter) {
  return {
    putThreadBlob: (workerId: string, threadId: string, sha256: string, data: Uint8Array, mimeType: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const thread = yield* sql`SELECT id FROM threads WHERE id=${threadId}::uuid
            AND worker_id=${workerId}::uuid AND deleted_at IS NULL FOR UPDATE`;

          if (!thread.length) return;
          yield* putBlob(sha256, data, mimeType);
          yield* sql`INSERT INTO thread_blobs(thread_id,sha256) VALUES(${threadId}::uuid,${sha256}) ON CONFLICT DO NOTHING`;
        }),
      ),
    putUnscopedBlob: (sha256: string, data: Uint8Array, mimeType: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* putBlob(sha256, data, mimeType);
          yield* sql`UPDATE blobs SET retention_exempt=true WHERE sha256=${sha256}`;
        }),
      ),
  };
}
