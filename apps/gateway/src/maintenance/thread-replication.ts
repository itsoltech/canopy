import { fromBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { contentHash, retainCurrentContent } from "../computers/range-leases.ts";

const BATCH = 256;
export const REPLICATION_REPLAY_RECORDS = 10_000;

/** Index pre-upgrade sealed references in bounded batches before any blob GC.
 * Pending projections have no issued hash; their eventual seal indexes it.
 */
const indexContent = (sql: SqlClient.SqlClient, thread: string) =>
  Effect.gen(function* () {
    for (const table of ["thread_replication_journal", "thread_replication_seed_entities"] as const) {
      const rows = yield* sql.unsafe<{ id: string; payload: Uint8Array }>(
        `SELECT ctid::text AS id,payload FROM ${table} WHERE thread_id=$1::uuid
          AND payload IS NOT NULL AND NOT content_indexed LIMIT 64 FOR UPDATE SKIP LOCKED`,
        [thread],
      );

      for (const row of rows) {
        // Malformed retained payloads still surface as DataLoss on replay. Do
        // not guess their references or collect content until they expire.
        let hash: string | null;
        let invalid = false;

        try {
          const record = fromBinary(ui.ThreadSyncRecordSchema, row.payload);
          hash = contentHash(record) ?? null;

          if (table === "thread_replication_journal" && hash) {
            const latest = yield* sql`SELECT 1 FROM thread_replication_journal j
              JOIN thread_replication_clock c ON c.thread_id=j.thread_id AND c.epoch=j.epoch
              JOIN thread_replication_content b ON b.thread_id=j.thread_id AND b.sha256=${hash}
              WHERE j.ctid=${row.id}::tid AND NOT EXISTS(SELECT 1 FROM thread_replication_journal newer
                WHERE newer.thread_id=j.thread_id AND newer.epoch=j.epoch AND newer.kind=j.kind
                  AND newer.entity_id=j.entity_id AND newer.seq>j.seq)`;

            if (latest.length) yield* retainCurrentContent(sql, thread, [record]);
          }
        } catch {
          hash = null;
          invalid = true;
        }

        yield* sql.unsafe(
          `UPDATE ${table} SET content_sha256=$2,content_indexed=true,content_invalid=$3 WHERE ctid=$1::tid`,
          [row.id, hash, invalid],
        );
      }

      if (rows.length) return rows.length;
    }

    return 0;
  });

/** Called within the durable owner maintenance lease. Never wait while holding
 * a barrier in the opposite order from a deferred source journal transaction.
 */
export const pruneThreadReplication = (sql: SqlClient.SqlClient, owner: string) =>
  Effect.gen(function* () {
    const thread = (yield* sql<{ thread_id: string }>`SELECT c.thread_id FROM thread_replication_clock c
      JOIN threads t ON t.id=c.thread_id WHERE c.owner_user_id=${owner}::uuid AND t.purged_at IS NULL AND (
        c.head_seq-c.replay_floor_seq>${REPLICATION_REPLAY_RECORDS} OR
        EXISTS(SELECT 1 FROM thread_replication_journal j WHERE j.thread_id=c.thread_id
          AND j.payload IS NOT NULL AND NOT j.content_indexed) OR
        EXISTS(SELECT 1 FROM thread_replication_seed_entities e WHERE e.thread_id=c.thread_id
          AND e.payload IS NOT NULL AND NOT e.content_indexed) OR
        EXISTS(SELECT 1 FROM thread_replication_snapshot_generations g WHERE g.thread_id=c.thread_id
          AND g.lease_until<=now()) OR
        EXISTS(SELECT 1 FROM thread_replication_content b WHERE b.thread_id=c.thread_id
          AND b.last_referenced_at<now()-interval '1 hour')
      )
      ORDER BY c.retention_checked_at,c.thread_id LIMIT 1`)[0]?.thread_id;

    if (!thread) return 0;

    const global = (yield* sql<{ locked: boolean }>`SELECT pg_try_advisory_xact_lock(
      hashtextextended('canopy.thread_mirror_journal',0)) AS locked`)[0];

    if (!global?.locked) {
      yield* sql`UPDATE thread_replication_clock SET retention_checked_at=now() WHERE ctid IN
        (SELECT ctid FROM thread_replication_clock WHERE thread_id=${thread}::uuid FOR UPDATE SKIP LOCKED)`;

      return 1;
    }

    const content = (yield* sql<{ locked: boolean }>`SELECT pg_try_advisory_xact_lock(
      hashtextextended('canopy.thread_content.'||${thread},0)) AS locked`)[0];

    if (!content?.locked) {
      yield* sql`UPDATE thread_replication_clock SET retention_checked_at=now() WHERE ctid IN
        (SELECT ctid FROM thread_replication_clock WHERE thread_id=${thread}::uuid FOR UPDATE SKIP LOCKED)`;

      return 1;
    }

    const range = (yield* sql<{ locked: boolean }>`SELECT pg_try_advisory_xact_lock(
      hashtextextended('canopy.thread_ranges:'||${thread},0)) AS locked`)[0];

    if (!range?.locked) {
      yield* sql`UPDATE thread_replication_clock SET retention_checked_at=now() WHERE ctid IN
        (SELECT ctid FROM thread_replication_clock WHERE thread_id=${thread}::uuid FOR UPDATE SKIP LOCKED)`;

      return 1;
    }

    const clock = (yield* sql<{ epoch: string; head: string; floor: string }>`SELECT epoch,head_seq::text AS head,
      replay_floor_seq::text AS floor FROM thread_replication_clock
      WHERE thread_id=${thread}::uuid AND owner_user_id=${owner}::uuid FOR UPDATE`)[0];

    if (!clock) return 0;

    let touched = (yield* sql`DELETE FROM thread_replication_content_leases WHERE ctid IN (
      SELECT ctid FROM thread_replication_content_leases WHERE thread_id=${thread}::uuid
      AND lease_until<=now() LIMIT ${BATCH}) RETURNING 1`).length;

    touched += (yield* sql`DELETE FROM thread_replication_snapshot_generations WHERE ctid IN (
      SELECT ctid FROM thread_replication_snapshot_generations WHERE thread_id=${thread}::uuid
      AND lease_until<=now() AND NOT EXISTS(SELECT 1 FROM thread_replication_content_leases l
        WHERE l.thread_id=thread_replication_snapshot_generations.thread_id
          AND l.generation=thread_replication_snapshot_generations.generation)
      LIMIT ${BATCH}) RETURNING 1`).length;

    touched += yield* indexContent(sql, thread);
    touched += (yield* sql`DELETE FROM thread_replication_journal WHERE ctid IN (
      SELECT ctid FROM thread_replication_journal WHERE thread_id=${thread}::uuid AND epoch<>${clock.epoch}::uuid
      LIMIT ${BATCH}) RETURNING 1`).length;

    const retained = (yield* sql<{ applied: string | null }>`SELECT min(applied_seq)::text AS applied
      FROM thread_replication_snapshot_generations WHERE thread_id=${thread}::uuid AND epoch=${clock.epoch}::uuid
      AND kind='range' AND lease_until>now()`)[0]?.applied;

    const ceiling = BigInt(clock.head) - BigInt(REPLICATION_REPLAY_RECORDS);

    const limit =
      retained === null || retained === undefined ? ceiling : BigInt(retained) < ceiling ? BigInt(retained) : ceiling;

    const rows = yield* sql<{
      seq: string;
      expired: boolean;
    }>`SELECT seq::text,(created_at<now()-interval '1 hour' AND content_indexed) AS expired
      FROM thread_replication_journal WHERE thread_id=${thread}::uuid AND epoch=${clock.epoch}::uuid
      AND payload IS NOT NULL
      AND seq>${clock.floor}::bigint AND seq<=${limit} ORDER BY thread_replication_journal.seq LIMIT ${BATCH}`;

    let floor = BigInt(clock.floor);

    for (const row of rows) {
      if (!row.expired || BigInt(row.seq) !== floor + 1n) break;
      floor++;
    }

    if (floor > BigInt(clock.floor)) {
      touched += (yield* sql`DELETE FROM thread_replication_journal WHERE thread_id=${thread}::uuid
        AND epoch=${clock.epoch}::uuid AND seq>${clock.floor}::bigint AND seq<=${floor} RETURNING 1`).length;
      yield* sql`UPDATE thread_replication_clock SET replay_floor_seq=${floor} WHERE thread_id=${thread}::uuid`;
    }

    touched += (yield* sql`DELETE FROM thread_replication_content c WHERE c.ctid IN (
      SELECT b.ctid FROM thread_replication_content b WHERE b.thread_id=${thread}::uuid
        AND b.last_referenced_at<now()-interval '1 hour'
        AND NOT EXISTS(SELECT 1 FROM thread_replication_entity_content e WHERE e.thread_id=b.thread_id
          AND e.sha256=b.sha256)
        AND NOT EXISTS(SELECT 1 FROM thread_replication_content_leases l WHERE l.thread_id=b.thread_id
          AND l.sha256=b.sha256 AND l.lease_until>now())
        AND NOT EXISTS(SELECT 1 FROM thread_replication_journal j WHERE j.thread_id=b.thread_id
          AND j.content_sha256=b.sha256)
        AND NOT EXISTS(SELECT 1 FROM thread_replication_seed_entities e WHERE e.thread_id=b.thread_id
          AND e.content_sha256=b.sha256)
        AND NOT EXISTS(SELECT 1 FROM thread_replication_journal j WHERE j.thread_id=b.thread_id
          AND j.payload IS NOT NULL AND NOT j.content_indexed)
        AND NOT EXISTS(SELECT 1 FROM thread_replication_journal j WHERE j.thread_id=b.thread_id
          AND j.content_invalid)
        AND NOT EXISTS(SELECT 1 FROM thread_replication_seed_entities e WHERE e.thread_id=b.thread_id
          AND NOT e.content_indexed)
        AND NOT EXISTS(SELECT 1 FROM thread_replication_seed_entities e WHERE e.thread_id=b.thread_id
          AND e.content_invalid)
      LIMIT ${BATCH} FOR UPDATE OF b SKIP LOCKED) RETURNING 1`).length;
    yield* sql`UPDATE thread_replication_clock SET retention_checked_at=now() WHERE thread_id=${thread}::uuid`;

    const pending = (yield* sql`SELECT 1 FROM thread_replication_clock WHERE owner_user_id=${owner}::uuid
      AND retention_checked_at<now()-interval '1 minute' AND thread_id<>${thread}::uuid LIMIT 1`).length;

    return touched || pending;
  });
