import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export interface Stats {
  readonly calls: number;
  readonly rows: number;
  readonly executionMs: number;
  readonly sharedHits: number;
  readonly sharedReads: number;
  readonly tempReads: number;
  readonly tempWrites: number;
}

/** Aggregate only our isolated database; exclude the counter read itself. */
export const stats = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return (yield* sql<Stats>`/*canopy_bench_stats*/ SELECT coalesce(sum(calls),0)::float8 AS calls,
    coalesce(sum(rows),0)::float8 AS rows,coalesce(sum(total_exec_time),0)::float8 AS "executionMs",
    coalesce(sum(shared_blks_hit),0)::float8 AS "sharedHits",
    coalesce(sum(shared_blks_read),0)::float8 AS "sharedReads",
    coalesce(sum(temp_blks_read),0)::float8 AS "tempReads",
    coalesce(sum(temp_blks_written),0)::float8 AS "tempWrites"
    FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND query NOT LIKE '%canopy_bench_stats%'`)[0]!;
});

export function difference(before: Stats, after: Stats, iterations: number): Stats {
  return {
    calls: (after.calls - before.calls) / iterations,
    rows: (after.rows - before.rows) / iterations,
    executionMs: (after.executionMs - before.executionMs) / iterations,
    sharedHits: (after.sharedHits - before.sharedHits) / iterations,
    sharedReads: (after.sharedReads - before.sharedReads) / iterations,
    tempReads: (after.tempReads - before.tempReads) / iterations,
    tempWrites: (after.tempWrites - before.tempWrites) / iterations,
  };
}
