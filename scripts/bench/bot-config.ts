import { migrate } from "@canopy/db";
import { Provider } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { BotStore } from "../../apps/gateway/src/bots/store.ts";
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
const foreign = "10000000-0000-4000-8000-000000000002";

const fixtures = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${foreign}::uuid,'foreign@example.invalid','Synthetic','user')`;
  yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash,os)
    SELECT md5('foreign-model-worker-'||n)::uuid,${foreign}::uuid,'Synthetic','synthetic','linux' FROM generate_series(1,32)n`;
  yield* sql`INSERT INTO worker_model_catalogs(worker_id,profiles)
    SELECT id,jsonb_build_array(
      jsonb_build_object('provider','PROVIDER_CODEX','profileId','native','models',jsonb_build_array(
        jsonb_build_object('id',CASE WHEN owner_user_id=${foreign}::uuid THEN 'foreign-model' ELSE 'owned-model' END))),
      jsonb_build_object('provider','PROVIDER_GROK','profileId','native','models',jsonb_build_array(
        jsonb_build_object('id','unrelated','displayName',repeat('x',65536)))),
      jsonb_build_object('provider','PROVIDER_CODEX','profileId','other','models',jsonb_build_array(
        jsonb_build_object('id','unrelated','displayName',repeat('x',65536))))) FROM workers`;
  yield* sql`INSERT INTO connector_accounts(id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,status,tools)
    SELECT md5('bot-config-connector-'||n)::uuid,${ids.owner}::uuid,'custom','Synthetic '||n,'synthetic_'||n,
      'https://example.invalid','http','headers','connected',jsonb_build_array(jsonb_build_object('blob',repeat('x',65536)))
    FROM generate_series(1,32)n`;
  yield* sql`INSERT INTO connector_bot_grants(account_id,bot_id)
    SELECT id,md5('bot-1')::uuid FROM connector_accounts WHERE owner_user_id=${ids.owner}::uuid`;
  yield* sql`ANALYZE`;
});

const run = (r: BenchRuntime, name: string) =>
  r.runPromise(
    BotStore.use((s) =>
      name === "bots/mcp-servers"
        ? Effect.asVoid(s.servers(ids.owner))
        : Effect.asVoid(s.harnessModels(ids.owner, Provider.CODEX, "native")),
    ),
  );

try {
  await normal.runPromise(migrate);
  await normal.runPromise(seed({ threads: 8, turns: 8, longTurns: 32, textBytes: 256 }));
  await normal.runPromise(fixtures);
  const results: object[] = [];

  for (const name of ["bots/mcp-servers", "bots/models"]) {
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
          "Private PostgreSQL18,pool8,max40.32 connector catalogs each64KiB;13 owned and32 foreign workers, each two unrelated64KiB profiles plus one native codex profile. Real bot store methods; no transport. Serial latency without tracing;separate rolled-back EXPLAIN ANALYZE;decoded JSON representation bytes.",
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
