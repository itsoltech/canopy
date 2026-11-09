import { migrate } from "@canopy/db";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { missingBlobs } from "../../apps/gateway/src/config-sync/environment-blobs.ts";
import { applyWaitingEnvironment } from "../../apps/gateway/src/config-sync/environment-sync.ts";
import { configLock } from "../../apps/gateway/src/config-sync/persistence.ts";
import { WAITING } from "../../apps/gateway/src/config-sync/environment-support.ts";
import { database } from "./database.ts";
import { runtime, type BenchRuntime } from "./runtime.ts";
import { ids, seed } from "./seed.ts";
import { Recorder } from "./trace.ts";
import { PlanCapture } from "./plan-capture.ts";

if (!process.argv.includes("--run")) throw new Error("Opt in with --run; only a new private database is used");

const owned = await database();
const normal = runtime(owned.url);
const recorder = new Recorder();
const diagnostic = runtime(owned.url, recorder);

const fixtures = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO config_items(owner_user_id,kind,global_id,local_id,revision,fields,unsupported)
    SELECT ${ids.owner}::uuid,'skill',md5('blob-record-'||n)::uuid::text,md5('blob-record-'||n)::uuid::text,n,
      (SELECT jsonb_object_agg('version.'||repeat(md5(v::text),2),
        jsonb_build_object('value',jsonb_build_object('commit','synthetic','checksum',repeat('a',64)),
          'hlc','1.0.synthetic','prev','')) FROM generate_series(1,64)v)
      ||jsonb_build_object('selected',jsonb_build_object('value',repeat(md5('1'),2),'hlc','1.0.synthetic','prev','')),
      CASE WHEN n=129 THEN ${WAITING} ELSE '' END FROM generate_series(1,129)n`;
  yield* sql`ANALYZE`;
});

const run = (r: BenchRuntime, name: string) =>
  name === "config/missing-blobs"
    ? r.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.asVoid(missingBlobs(sql, ids.owner))))
    : r.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.withTransaction(
            Effect.andThen(configLock(sql, ids.owner), Effect.asVoid(applyWaitingEnvironment(sql, ids.owner))),
          ),
        ),
      );

try {
  await normal.runPromise(migrate);
  await normal.runPromise(seed({ threads: 8, turns: 8, longTurns: 32, textBytes: 256 }));
  await normal.runPromise(fixtures);
  const results: object[] = [];

  for (const name of ["config/missing-blobs", "config/recheck-waiting"]) {
    const times: number[] = [];
    const rounds: number[] = [];

    for (let round = 0; round < 3; round++) {
      const current: number[] = [];

      for (let i = 0; i < 22; i++) {
        const start = performance.now();
        await run(normal, name);

        if (i >= 2) current.push(performance.now() - start);
      }

      times.push(...current);
      rounds.push(current.toSorted((a, b) => a - b)[18]!);
    }

    recorder.samples = [];
    recorder.planCapture = new PlanCapture();
    await run(diagnostic, name);
    const samples = recorder.samples;
    recorder.samples = undefined;
    results.push({
      operation: name,
      p95Ms: times.toSorted((a, b) => a - b)[56],
      roundP95Ms: rounds,
      queries: samples.length,
      rows: samples.reduce((n, s) => n + s.rows, 0),
      decodedJsonBytes: samples.reduce((n, s) => n + s.bytes, 0),
      plans: recorder.planCapture.plans,
    });
  }

  console.log(
    JSON.stringify(
      {
        iterations: 20,
        rounds: 3,
        warmups: 2,
        results,
        method:
          "Private PostgreSQL18,pool8,max40.129 records each naming64 missing versions;128 applied metadata records and1 waiting for selected content. Real missingBlobs/applyWaitingEnvironment; no transport. Serial untraced latency, separate rolled-back EXPLAIN ANALYZE; decoded JSON representation bytes.",
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
