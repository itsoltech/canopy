import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { prepareRangeLegacy } from "./range-legacy.ts";
import type { RangeSourceStore } from "./range-source.ts";

/** Bootstrap ids and serialize with source commits without decoding historical payloads. */
export function prepareRangeClock(sql: SqlClient.SqlClient, store: RangeSourceStore, thread: string) {
  return Effect.gen(function* () {
    const authorized = yield* sql`SELECT id FROM threads WHERE id=${thread}::uuid
      AND owner_user_id=${store.owner}::uuid AND deleted_at IS NULL FOR KEY SHARE`;

    if (!authorized.length) return yield* Effect.fail(new ConnectError("Thread not found", Code.NotFound));
    // Moves lock the source row before their deferred journal trigger. Acquire the
    // foreign-key lock in that order too, before owning the commit barrier.
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('canopy.thread_ranges:' || ${thread},0))`;

    const clock = (yield* sql<{ epoch: string; head_seq: string; legacy_ready: boolean }>`
      SELECT epoch,head_seq::text,legacy_ready FROM thread_replication_clock
      WHERE thread_id=${thread}::uuid FOR UPDATE`)[0];

    if (clock?.legacy_ready) return clock;

    if (!clock)
      yield* sql`INSERT INTO thread_replication_clock(thread_id,owner_user_id)
        VALUES(${thread}::uuid,${store.owner}::uuid)`;

    yield* prepareRangeLegacy(sql, store, thread);

    if (!clock) yield* sql`SELECT thread_replication_seed(${thread}::uuid)`;

    return (yield* sql<{ epoch: string; head_seq: string }>`SELECT epoch,head_seq::text FROM thread_replication_clock
      WHERE thread_id=${thread}::uuid FOR UPDATE`)[0]!;
  });
}
