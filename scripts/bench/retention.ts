import { migrate } from "@canopy/db";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pruneDatabase } from "../../apps/gateway/src/maintenance/prune.ts";
import { database } from "./database.ts";
import { runtime } from "./runtime.ts";
import { ids, seed } from "./seed.ts";
import { Recorder } from "./trace.ts";

if (!process.argv.includes("--run")) throw new Error("Opt in with --run; only a private database is used");

const owned = await database();
const normal = runtime(owned.url);
const recorder = new Recorder();
const diagnostic = runtime(owned.url, recorder);
const rowsPerGeneration = 4096;
const generation = "50000000-0000-4000-8000-000000000001";
const before: number[] = [];
const after: number[] = [];
const totals: number[] = [];

const prepare = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO computer_mirror_generations(owner_user_id,origin_node_id,generation,subscription_id,lease_until)
    SELECT owner_user_id,origin_node_id,${generation}::uuid,subscription_id,now()-interval '1 hour'
    FROM computer_mirror_state WHERE owner_user_id=${ids.owner}::uuid ON CONFLICT DO NOTHING`;
  yield* sql`INSERT INTO computer_mirror_threads(owner_user_id,origin_node_id,generation,thread_id,snapshot,thread_metadata)
    SELECT ${ids.owner}::uuid,'benchmark-peer',${generation}::uuid,md5('retention-'||n)::uuid,
    convert_to(repeat(md5(n::text),128),'UTF8'),''::bytea FROM generate_series(1,${rowsPerGeneration}) n`;
  yield* sql`UPDATE database_maintenance SET next_run_at=now() WHERE owner_user_id=${ids.owner}::uuid`;
});

const due = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE database_maintenance SET next_run_at=now() WHERE owner_user_id=${ids.owner}::uuid`;
});

const legacy = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT generation FROM computer_mirror_state WHERE owner_user_id=${ids.owner}::uuid AND origin_node_id='benchmark-peer' FOR UPDATE`;

      return yield* sql`DELETE FROM computer_mirror_threads t USING computer_mirror_state s
      WHERE t.owner_user_id=s.owner_user_id AND t.origin_node_id=s.origin_node_id
      AND t.owner_user_id=${ids.owner}::uuid AND t.origin_node_id='benchmark-peer' AND t.generation<>s.generation`;
    }),
  );
});

try {
  await normal.runPromise(migrate);
  await normal.runPromise(seed({ threads: 8, turns: 8, longTurns: 40, textBytes: 256 }));
  await normal.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO computer_mirror_state(owner_user_id,origin_node_id)
      VALUES(${ids.owner}::uuid,'benchmark-peer')`;
    }),
  );

  for (let i = 0; i < 22; i++) {
    await normal.runPromise(prepare);
    const start = performance.now();
    await normal.runPromise(legacy);

    if (i >= 2) before.push(performance.now() - start);
    await normal.runPromise(prepare);
    const started = performance.now();
    let deleted = 0;
    let first = 0;

    while (deleted < rowsPerGeneration) {
      await normal.runPromise(due);
      const tick = performance.now();
      const count = await normal.runPromise(pruneDatabase(ids.owner));

      if (!deleted) first = performance.now() - tick;

      if (!count) throw new Error("Retention did not make progress");
      deleted += count;
    }

    if (i >= 2) {
      after.push(first);
      totals.push(performance.now() - started);
    }
  }

  await normal.runPromise(prepare);
  recorder.samples = [];
  await diagnostic.runPromise(pruneDatabase(ids.owner));
  const samples = recorder.samples;
  recorder.samples = undefined;
  const p95 = (values: number[]) => values.toSorted((a, b) => a - b)[18];
  console.log(
    JSON.stringify(
      {
        iterations: 20,
        warmups: 2,
        rowsPerGeneration,
        logicalSnapshotBytesPerRow: 4096,
        legacyCheckpointCleanupP95Ms: p95(before),
        boundedFirstBatchP95Ms: p95(after),
        boundedFullDrainP95Ms: p95(totals),
        foregroundCleanupRowsBefore: rowsPerGeneration,
        foregroundCleanupRowsAfter: 0,
        batchRows: 256,
        batchQueries: samples.length,
        batchReturnedRows: samples.reduce((n, s) => n + s.rows, 0),
        batchDecodedJsonBytes: samples.reduce((n, s) => n + s.bytes, 0),
        method:
          "Private PostgreSQL 18, max_connections=40, pool 8. Old checkpoint state lock plus unbounded DELETE compared with the complete maintenance transaction. Full drain forcibly advances the durable due time between batches; normal production timer yields between batches. No physical disk shrink claim.",
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await diagnostic.dispose();
    await normal.dispose();
  } finally {
    await owned.stop();
  }
}
