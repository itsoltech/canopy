import { migrate } from "@canopy/db";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore, InstanceStore } from "../../apps/gateway/src/store/index.ts";
import * as imports from "../../apps/gateway/src/imports/store.ts";
import { instanceReads, instanceWrites } from "../../apps/gateway/src/store/instance-queries.ts";
import { database } from "./database.ts";
import { runtime } from "./runtime.ts";
import { ids, seed } from "./seed.ts";
import { seedQueues } from "./queues.ts";
import { Recorder } from "./trace.ts";
import { PlanCapture } from "./plan-capture.ts";
import type { Operation } from "./operations.ts";

if (!process.argv.includes("--run")) throw new Error("Opt in with --run; only a new private database is used");

const baseline = process.argv.includes("--baseline");
const owned = await database();
const normal = runtime(owned.url);
const recorder = new Recorder();
const diagnostic = runtime(owned.url, recorder);
const foreign = "10000000-0000-4000-8000-000000000002";
const largeRun = Bun.MD5.hash("large-import-1", "hex");

const operations: Operation[] = [
  {
    name: "connectors/list-32",
    run: async (r) => {
      await r.runPromise(
        GatewayStore.use((s) =>
          Effect.gen(function* () {
            const rows = yield* s.connectors.list(ids.owner, {}, !baseline);

            if (baseline) yield* Effect.forEach(rows, s.connectors.view);
            else yield* s.connectors.views(rows);
          }),
        ),
      );
    },
  },
  {
    name: "instances/list-owner",
    run: async (r) => {
      await r.runPromise(InstanceStore.use((s) => s.list(ids.owner)));
    },
  },
  {
    name: "instances/assign-workers",
    run: async (r) => {
      await r.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* instanceWrites(sql, Buffer.alloc(32, 1), instanceReads(sql)).assign("codex", "native", false, [
            ids.worker,
          ]);
        }),
      );
    },
  },
  {
    name: "imports/runner-admission",
    run: async (r) => {
      await r.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          if (baseline) yield* imports.runs(sql, ids.owner, largeRun);
          else yield* imports.runnerRun(sql, ids.owner, largeRun);
        }),
      );
    },
  },
];

try {
  await normal.runPromise(migrate);
  await normal.runPromise(seed({ threads: 32, turns: 8, longTurns: 2048, textBytes: 256 }));
  await normal.runPromise(seedQueues);
  await normal.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${foreign}::uuid,'foreign@example.invalid','Synthetic','user')`;
      yield* sql`INSERT INTO provider_instances(harness,id,kind,label,created_by,env)
      SELECT 'codex','foreign-'||n,'native','Synthetic',${foreign}::uuid,
        jsonb_build_array(jsonb_build_object('name','SYNTHETIC','value',repeat('x',65536))) FROM generate_series(1,32)n`;
      yield* sql`INSERT INTO connector_accounts(id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,status,tools)
      SELECT md5('bench-connector-'||n)::uuid,${ids.owner}::uuid,'custom','Synthetic '||n,'synthetic_'||n,
        'https://example.invalid','http','headers','connected',jsonb_build_array(jsonb_build_object('blob',repeat('x',65536)))
      FROM generate_series(1,32)n`;
      yield* sql`INSERT INTO connector_worker_grants(account_id,worker_id) SELECT id,${ids.worker}::uuid
      FROM connector_accounts WHERE owner_user_id=${ids.owner}::uuid`;
      yield* sql`INSERT INTO connector_bot_grants(account_id,bot_id) SELECT a.id,b.id FROM connector_accounts a
      CROSS JOIN LATERAL (SELECT id FROM bots ORDER BY id LIMIT 1)b WHERE a.owner_user_id=${ids.owner}::uuid`;
      yield* sql`ANALYZE`;
    }),
  );
  const results: object[] = [];

  for (const operation of operations) {
    const times: number[] = [];

    for (let i = 0; i < 22; i++) {
      const start = performance.now();
      await operation.run(normal);

      if (i >= 2) times.push(performance.now() - start);
    }

    recorder.samples = [];
    recorder.planCapture = new PlanCapture();
    await operation.run(diagnostic);
    const samples = recorder.samples;
    recorder.samples = undefined;
    results.push({
      operation: operation.name,
      p95Ms: times.toSorted((a, b) => a - b)[18],
      queries: samples.length,
      rows: samples.reduce((n, s) => n + s.rows, 0),
      decodedJsonBytes: samples.reduce((n, s) => n + s.bytes, 0),
      plans: recorder.planCapture.plans,
    });
  }

  console.log(
    JSON.stringify(
      {
        baseline,
        iterations: 20,
        warmups: 2,
        results,
        method:
          "Private PostgreSQL18;32 connector tool catalogs and32 foreign provider environments each64KiB;13 workers;one2000-item import. Serial latency without tracing; separate rolled-back EXPLAIN ANALYZE. JSON bytes are decoded representation, not transport.",
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
