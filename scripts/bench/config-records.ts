import { migrate } from "@canopy/db";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ConfigSync } from "../../apps/gateway/src/config-sync/engine.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
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
const node = "b".repeat(64);
const sync = (r: BenchRuntime) => new ConfigSync(new ComputerStore(r, ids.owner, Buffer.alloc(32, 1)), {}, () => node);

const prepare = () =>
  normal.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM config_items WHERE owner_user_id=${ids.owner}::uuid`;
      yield* sql`DELETE FROM config_clock WHERE owner_user_id=${ids.owner}::uuid`;
    }),
  );

try {
  await normal.runPromise(migrate);
  await normal.runPromise(seed({ threads: 8, turns: 8, longTurns: 32, textBytes: 256 }));
  await normal.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO computer_identity(owner_user_id,node_id,name,certificate,private_key)
      VALUES(${ids.owner}::uuid,${node},'Synthetic','Synthetic',${Buffer.alloc(32)})`;
      yield* sql`INSERT INTO instruction_documents(id,owner_user_id,revision,document)
      SELECT md5('config-document-'||n)::uuid,${ids.owner}::uuid,1,jsonb_build_object(
        'id',md5('config-document-'||n)::uuid::text,'name','Synthetic '||n,'harness','codex',
        'selector',jsonb_build_object('everyone',true),'platformHome',true,
        'fragments',jsonb_build_array(jsonb_build_object('id',n::text,'name','Synthetic','content',repeat(md5(n::text),128))))
      FROM generate_series(1,128)n`;
      yield* sql`ANALYZE`;
    }),
  );
  const results: object[] = [];

  for (const cold of [true, false]) {
    const times: number[] = [];
    const rounds: number[] = [];

    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 22; i++) {
        if (cold) await prepare();
        const start = performance.now();
        await sync(normal).start();

        if (i >= 2) times.push(performance.now() - start);
      }

      rounds.push(times.slice(-20).toSorted((a, b) => a - b)[18]!);
    }

    if (cold) await prepare();
    recorder.samples = [];
    recorder.planCapture = new PlanCapture();
    await sync(diagnostic).start();
    const samples = recorder.samples;
    recorder.samples = undefined;
    results.push({
      operation: cold ? "config-records/bootstrap" : "config-records/steady-restart",
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
        rounds: 3,
        iterations: 20,
        warmups: 2,
        results,
        method:
          "Private PostgreSQL18,pool8,max40. ConfigSync.start with128 instruction documents of4KiB,24 projects and13 workers. Cold bootstrap clears owned configuration state outside timing; steady restart retains it. Real service without link transport. Separate rolled-back EXPLAIN ANALYZE. JSON bytes are decoded representation.",
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
