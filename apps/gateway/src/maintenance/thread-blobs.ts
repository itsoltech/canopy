import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

// Two hashes per attachment plus one per preview keep blob deletion below 256 rows too.
const BATCH = 64;

/** Called under the purged thread's lifecycle lock, inside the maintenance transaction. */
export const pruneThreadBlobs = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    const attachments = yield* sql<{ id: string; sha256: string; thumb_sha256: string | null }>`
      SELECT id,sha256,thumb_sha256 FROM attachments WHERE thread_id=${threadId}::uuid
      ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`;

    const previews = yield* sql<{ sha256: string }>`SELECT sha256 FROM thread_blobs
      WHERE thread_id=${threadId}::uuid ORDER BY sha256 LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`;

    const hashes = [
      ...new Set([
        ...attachments.flatMap((row) => (row.thumb_sha256 ? [row.sha256, row.thumb_sha256] : [row.sha256])),
        ...previews.map((row) => row.sha256),
      ]),
    ].sort();

    // Every blob/reference INSERT takes this same lock. The following statements then see
    // references committed while we waited; an upload inserts bytes and ownership atomically.
    if (hashes.length)
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('canopy.blob.'||hash,0))
        FROM (SELECT unnest(${hashes}::text[]) AS hash ORDER BY 1) ordered`;

    if (attachments.length) {
      // An attachment can still belong to an unsent draft on another device/target.
      // Preserve its bytes and make that draft's copy independent of the removed turn.
      yield* sql`UPDATE attachments a SET thread_id=NULL,turn_id=NULL WHERE thread_id=${threadId}::uuid
        AND id=ANY(${attachments.map((row) => row.id)}::uuid[])
        AND (EXISTS(SELECT 1 FROM composer_draft_attachments d WHERE d.attachment_id=a.id)
          OR EXISTS(SELECT 1 FROM bot_composer_drafts d WHERE d.owner_user_id=a.owner_user_id
            AND (d.attachment_ids IS NULL OR a.id=ANY(d.attachment_ids))))`;
      yield* sql`DELETE FROM attachments WHERE thread_id=${threadId}::uuid AND id=ANY(${attachments.map((row) => row.id)}::uuid[])`;
    }

    if (previews.length)
      yield* sql`DELETE FROM thread_blobs WHERE thread_id=${threadId}::uuid AND sha256=ANY(${previews.map((row) => row.sha256)}::text[])`;

    if (hashes.length)
      yield* sql`DELETE FROM blobs b WHERE sha256=ANY(${hashes}::text[]) AND NOT retention_exempt
        AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.sha256=b.sha256 OR a.thumb_sha256=b.sha256)
        AND NOT EXISTS(SELECT 1 FROM thread_blobs t WHERE t.sha256=b.sha256)`;

    return attachments.length + previews.length;
  });
