import { fromBinary } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

const BATCH = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Called in the maintenance transaction. Unknown legacy bot drafts inhibit collection until indexed. */
export const pruneStorage = (sql: SqlClient.SqlClient, owner: string) =>
  Effect.gen(function* () {
    const expiredUploads = yield* sql`DELETE FROM worker_preview_uploads WHERE ctid IN (
      SELECT ctid FROM worker_preview_uploads WHERE expires_at<=now()
      ORDER BY expires_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED) RETURNING 1`;

    const expiredClaims = yield* sql`DELETE FROM thread_blobs WHERE ctid IN (
      SELECT p.ctid FROM thread_blobs p JOIN threads t ON t.id=p.thread_id
      WHERE NOT p.verified AND NOT p.retained_history AND p.unverified_until<=now() AND t.owner_user_id=${owner}::uuid
      ORDER BY p.unverified_until,p.thread_id,p.sha256 LIMIT ${BATCH} FOR UPDATE OF p SKIP LOCKED) RETURNING 1`;

    const expiredQuarantine = yield* sql`DELETE FROM worker_event_quarantine WHERE event_id IN (
      SELECT q.event_id FROM worker_event_quarantine q WHERE q.created_at<=now()-interval '7 days'
        AND (EXISTS(SELECT 1 FROM threads t WHERE t.id=q.thread_id AND t.owner_user_id=${owner}::uuid)
          OR EXISTS(SELECT 1 FROM bots b WHERE b.id=q.thread_id AND b.owner_user_id=${owner}::uuid)
          OR (NOT EXISTS(SELECT 1 FROM threads t WHERE t.id=q.thread_id)
            AND NOT EXISTS(SELECT 1 FROM bots b WHERE b.id=q.thread_id)))
      ORDER BY q.created_at,q.event_id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED) RETURNING 1`;

    const expired = expiredUploads.length + expiredClaims.length + expiredQuarantine.length;

    const drafts = yield* sql<{ bot_id: string; payload: Uint8Array }>`SELECT bot_id,payload FROM bot_composer_drafts
      WHERE owner_user_id=${owner}::uuid AND attachment_ids IS NULL AND attachment_index_retry_at<=now() ORDER BY attachment_index_retry_at,bot_id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`;

    let indexed = 0;

    for (const draft of drafts) {
      const decoded = yield* Effect.try(() => fromBinary(bots.BotComposerDraftSchema, draft.payload)).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );

      // An unreadable legacy draft conservatively protects this owner, without stopping unrelated maintenance.
      if (!decoded || decoded.attachments.some((attachment) => !UUID.test(attachment.id))) {
        yield* sql`UPDATE bot_composer_drafts SET attachment_index_retry_at=now()+interval '1 day' WHERE bot_id=${draft.bot_id}::uuid`;
        continue;
      }

      indexed++;
      yield* sql`UPDATE bot_composer_drafts SET attachment_ids=${decoded.attachments.map((a) => a.id)}::uuid[]
        WHERE bot_id=${draft.bot_id}::uuid`;
    }

    const uploads = yield* sql<{ id: string }>`SELECT a.id FROM attachments a
      WHERE a.owner_user_id=${owner}::uuid AND a.thread_id IS NULL AND a.bot_id IS NULL
        AND a.created_at<now()-interval '30 days'
        AND NOT EXISTS(SELECT 1 FROM composer_draft_attachments d WHERE d.attachment_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM bot_composer_drafts d WHERE d.owner_user_id=a.owner_user_id
          AND (d.attachment_ids IS NULL OR a.id=ANY(d.attachment_ids)))
        AND NOT EXISTS(SELECT 1 FROM thread_rewinds r JOIN threads t ON t.id=r.thread_id
          WHERE t.owner_user_id=a.owner_user_id AND t.purged_at IS NULL
            AND r.draft @> jsonb_build_object('attachments',jsonb_build_array(jsonb_build_object('id',a.id::text))))
      ORDER BY a.created_at,a.id LIMIT ${BATCH} FOR UPDATE OF a SKIP LOCKED`;

    // Composer FKs and botImages FOR UPDATE serialize saves with this row lock.
    // Re-read references in a fresh statement after candidate locks (a concurrent save may just have committed).
    const removed = uploads.length
      ? yield* sql`DELETE FROM attachments a WHERE a.id=ANY(${uploads.map((a) => a.id)}::uuid[])
          AND a.thread_id IS NULL AND a.bot_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM composer_draft_attachments d WHERE d.attachment_id=a.id)
          AND NOT EXISTS(SELECT 1 FROM bot_composer_drafts d WHERE d.owner_user_id=a.owner_user_id
            AND (d.attachment_ids IS NULL OR a.id=ANY(d.attachment_ids)))
          AND NOT EXISTS(SELECT 1 FROM thread_rewinds r JOIN threads t ON t.id=r.thread_id
            WHERE t.owner_user_id=a.owner_user_id AND t.purged_at IS NULL
              AND r.draft @> jsonb_build_object('attachments',jsonb_build_array(jsonb_build_object('id',a.id::text)))) RETURNING id`
      : [];

    // Blobs have no owner: bytes are shared by hash. Every owner's references protect them equally.
    const blobs = yield* sql<{ sha256: string }>`SELECT b.sha256 FROM blobs b
      WHERE (b.legacy_retention_until IS NULL OR b.legacy_retention_until<=now())
        AND b.created_at<now()-interval '7 days'
        AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.sha256=b.sha256 OR a.thumb_sha256=b.sha256)
        AND NOT EXISTS(SELECT 1 FROM thread_blobs t WHERE t.sha256=b.sha256 AND (t.verified OR t.retained_history))
      ORDER BY b.created_at,b.sha256 LIMIT ${BATCH}`;

    const hashes = blobs.map((b) => b.sha256).sort();

    if (!hashes.length) return expired + indexed + removed.length;
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('canopy.blob.'||hash,0))
      FROM (SELECT unnest(${hashes}::text[]) AS hash ORDER BY 1) ordered`;

    // A concurrent writer may have committed references while we waited for its hash lock.
    const deleted = yield* sql`DELETE FROM blobs b WHERE b.sha256=ANY(${hashes}::text[])
      AND (b.legacy_retention_until IS NULL OR b.legacy_retention_until<=now())
      AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.sha256=b.sha256 OR a.thumb_sha256=b.sha256)
      AND NOT EXISTS(SELECT 1 FROM thread_blobs t WHERE t.sha256=b.sha256 AND (t.verified OR t.retained_history)) RETURNING sha256`;

    return expired + indexed + removed.length + deleted.length;
  });
