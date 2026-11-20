import type { JsonValue } from "@bufbuild/protobuf";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { compactEventRaw } from "../store/transcript-raw.ts";

const BATCH = 256;
const BYTE_BUDGET = 2 * 1024 * 1024;
const MAX_ROW_BYTES = 4 * 1024 * 1024;
const MAX_DETOASTS = 4;
const ITEM_KINDS = new Set(["item_started", "item_delta", "item_completed"]);

/**
 * Bounded retrospective compaction. It never holds the thread row lock: ingestion only
 * appends immutable events, while the content advisory lock fences purge/delete.
 */
export const compactTranscript = (sql: SqlClient.SqlClient, owner: string) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const thread = (yield* sql<{
        id: string;
        scanned_seq: bigint;
      }>`SELECT t.id,coalesce(c.scanned_seq,0) AS scanned_seq
      FROM threads t LEFT JOIN thread_transcript_compaction c ON c.thread_id=t.id
      WHERE t.owner_user_id=${owner}::uuid AND t.purged_at IS NULL AND t.deleted_at IS NULL
        AND t.moved_to IS NULL AND t.rewind_pending_id IS NULL
        AND t.last_seq>coalesce(c.scanned_seq,0)
        AND (c.updated_at IS NULL OR c.updated_at<now()-interval '1 minute')
        AND EXISTS (SELECT 1 FROM thread_events old
          WHERE old.thread_id=t.id AND old.seq>coalesce(c.scanned_seq,0)
            AND old.recorded_at<now()-interval '1 hour')
        AND NOT EXISTS(SELECT 1 FROM turns u WHERE u.thread_id=t.id AND u.status IN ('queued','running'))
        AND NOT EXISTS(SELECT 1 FROM thread_items i WHERE i.thread_id=t.id AND i.status='in_progress')
      ORDER BY c.updated_at NULLS FIRST,t.id LIMIT 1`)[0];

      if (!thread) return 0;

      const contentLock = (yield* sql<{ locked: boolean }>`SELECT pg_try_advisory_xact_lock(
      hashtextextended('canopy.thread_content.'||${thread.id},0)) AS locked`)[0];

      if (!contentLock?.locked) return 0;

      if (
        !(yield* sql`SELECT 1 FROM threads WHERE id=${thread.id}::uuid
      AND purged_at IS NULL AND deleted_at IS NULL`).length
      )
        return 0;

      return yield* sql.withTransaction(scanTranscript(sql, thread.id, BigInt(thread.scanned_seq))).pipe(
        Effect.catchTag("SqlError", () =>
          sql.withTransaction(
            Effect.gen(function* () {
              // A slow/invalid old row must not roll back the owner's other retention work.
              yield* checkpoint(sql, thread.id, BigInt(thread.scanned_seq), false);

              return 1;
            }),
          ),
        ),
      );
    }),
  );

const checkpoint = (sql: SqlClient.SqlClient, threadId: string, scanned: bigint, progress = true) =>
  sql`INSERT INTO thread_transcript_compaction(thread_id,scanned_seq) VALUES(${threadId}::uuid,${scanned})
    ON CONFLICT(thread_id) DO UPDATE SET
      scanned_seq=CASE WHEN ${progress} THEN excluded.scanned_seq ELSE thread_transcript_compaction.scanned_seq END,
      updated_at=now()`;

const scanTranscript = (sql: SqlClient.SqlClient, threadId: string, initialSeq: bigint) =>
  Effect.gen(function* () {
    const previousTimeout = (yield* sql<{
      timeout: string;
    }>`SELECT current_setting('statement_timeout') AS timeout`)[0];

    yield* sql`SET LOCAL statement_timeout='250ms'`;

    const rows = yield* sql<{
      seq: bigint;
      kind: string;
      recorded_at: Date;
      raw_bytes: number | null;
      payload_bytes: number;
      refs: boolean;
    }>`
      SELECT seq,kind,recorded_at,pg_column_size(raw) AS raw_bytes,pg_column_size(payload) AS payload_bytes,
             raw_payload_refs IS NOT NULL AS refs
      FROM thread_events
      WHERE thread_id=${threadId}::uuid AND seq>${initialSeq}
      ORDER BY seq LIMIT ${BATCH}`;

    if (!rows.length) return 0;
    let compacted = 0;
    let scanned = initialSeq;
    let bytes = 0;
    const load = new Set<bigint>();
    let inspected = 0;

    for (const row of rows) {
      if (row.recorded_at >= new Date(Date.now() - 60 * 60 * 1000)) break;

      if (!row.raw_bytes || row.refs || !ITEM_KINDS.has(row.kind)) {
        scanned = BigInt(row.seq);
        continue;
      }

      if (inspected >= MAX_DETOASTS) break;
      const previousSeq = scanned;
      scanned = BigInt(row.seq);
      const rowBytes = row.raw_bytes + row.payload_bytes;

      if (row.raw_bytes > MAX_ROW_BYTES || rowBytes > MAX_ROW_BYTES) continue;
      inspected++;

      const size = (yield* sql<{ bytes: number }>`SELECT octet_length(raw::text)+octet_length(payload::text) AS bytes
        FROM thread_events WHERE thread_id=${threadId}::uuid AND seq=${row.seq}`)[0];

      if (!size || size.bytes > BYTE_BUDGET) continue;

      if (bytes + size.bytes > BYTE_BUDGET) {
        scanned = previousSeq;
        break;
      }

      bytes += size.bytes;
      load.add(row.seq);
    }

    if (load.size) {
      const selected = yield* sql<{ seq: bigint; kind: string; payload: JsonValue; raw_text: string }>`
        SELECT seq,kind,payload,raw::text AS raw_text FROM thread_events
        WHERE thread_id=${threadId}::uuid AND seq=ANY(${[...load]}::bigint[])`;

      for (const row of selected) {
        const result = compactEventRaw(row.kind, row.payload, row.raw_text);

        if (!result) continue;
        compacted += (yield* sql`WITH candidate AS MATERIALIZED (
            SELECT thread_id,seq,raw,payload FROM thread_events
            WHERE thread_id=${threadId}::uuid AND seq=${row.seq} AND raw_payload_refs IS NULL FOR UPDATE
          ), applied AS (
            SELECT c.thread_id,c.seq,a.raw,a.refs FROM candidate c
            CROSS JOIN LATERAL thread_event_apply_raw_refs(c.raw,c.payload,${result.refs}::jsonb) a
          )
          UPDATE thread_events e SET raw=a.raw,raw_payload_refs=a.refs FROM applied a
          WHERE e.thread_id=a.thread_id AND e.seq=a.seq AND a.refs IS NOT NULL RETURNING e.seq`).length;
      }
    }

    yield* checkpoint(sql, threadId, scanned);
    yield* sql`SELECT set_config('statement_timeout',${previousTimeout?.timeout ?? "0"},true)`;

    return Math.max(1, compacted);
  });
