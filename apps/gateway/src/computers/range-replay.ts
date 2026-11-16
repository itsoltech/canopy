import type { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { RangeSourceStore } from "./range-source.ts";
import { rangeBatch, rangeRows, type RangeHead } from "./range-source-rows.ts";
import { leaseRangeRecords } from "./range-leases.ts";

/** Sealed replay takes shared barriers, never a clock FOR UPDATE. The barriers
 * keep retention and purge out until issued hashes have durable leases.
 */
export function replaySealedRange(
  sql: SqlClient.SqlClient,
  store: RangeSourceStore,
  cursor: ui.ThreadSyncCursor,
  through: bigint,
  subscription: string,
  head?: RangeHead,
) {
  return Effect.gen(function* () {
    if (!head || head.epoch !== cursor.epoch || head.seq <= cursor.appliedSeq) return undefined;

    const authorized = yield* sql`SELECT id FROM threads WHERE id=${cursor.threadId}::uuid
      AND owner_user_id=${store.owner}::uuid AND deleted_at IS NULL FOR KEY SHARE`;

    if (!authorized.length) return undefined;
    yield* sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('canopy.thread_content.'||${cursor.threadId},0))`;
    yield* sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('canopy.thread_ranges:'||${cursor.threadId},0))`;
    const end = through > 0n && through < head.seq ? through : head.seq;
    const rows = yield* rangeRows(sql, store.owner, cursor.threadId, head.epoch, cursor.appliedSeq, end);

    if (!rows.length || rows.some((row) => !row.payload)) return undefined;
    const batch = rangeBatch(cursor, head.seq, end, rows, subscription);
    yield* leaseRangeRecords(
      sql,
      cursor.threadId,
      cursor.epoch,
      head.seq,
      cursor.appliedSeq,
      batch.records,
      subscription || crypto.randomUUID(),
    );

    return batch;
  });
}
