import { expect, test } from "bun:test";
import { create, type JsonObject } from "@bufbuild/protobuf";
import { UsageSchema, UsageScope } from "@canopy/contracts";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrate, migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";
import { recordUsage } from "../../../apps/gateway/src/usage/accounting.ts";

const hour = new Date("2026-11-18T17:00:00Z");

function threadCounter(sql: SqlClient.SqlClient, owner: string, project: string, worker: string, totals: JsonObject) {
  return Effect.gen(function* () {
    const workspace = Bun.randomUUIDv7();
    const thread = Bun.randomUUIDv7();
    const turn = Bun.randomUUIDv7();
    yield* sql`INSERT INTO project_workspaces(id,project_id,worker_id,root_path) VALUES(${workspace}::uuid,${project}::uuid,${worker}::uuid,'/repo')`;
    yield* sql`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,worker_id,workspace_id,cwd)
      VALUES(${thread}::uuid,${project}::uuid,${owner}::uuid,'main',${thread}::uuid,'worker','codex',${worker}::uuid,${workspace}::uuid,'/repo')`;
    yield* sql`INSERT INTO turns(id,thread_id,ordinal,status,trigger,input,first_seq,last_seq)
      VALUES(${turn}::uuid,${thread}::uuid,1,'completed','provider','{}',1,1)`;
    yield* sql`INSERT INTO usage_counters(owner_user_id,subject_id,thread_id,thread_turn_id,provider,model,counter_id,first_bucket,totals)
      VALUES(${owner}::uuid,${`thread:${thread}`},${thread}::uuid,${turn}::uuid,'codex','common',${turn},${hour},${JSON.stringify(totals)}::jsonb)`;
  });
}

function botCounter(sql: SqlClient.SqlClient, owner: string, bot: string, worker: string) {
  return Effect.gen(function* () {
    const turn = Bun.randomUUIDv7();
    const command = Bun.randomUUIDv7();
    yield* sql`INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance)
      VALUES(${bot}::uuid,${owner}::uuid,${bot},'{"name":"Routine"}','codex','native')`;
    yield* sql`INSERT INTO bot_turns(id,bot_id,client_request_id,input) VALUES(${turn}::uuid,${bot}::uuid,${turn},'')`;
    yield* sql`INSERT INTO worker_commands(id,worker_id,kind,payload,expires_at) VALUES(${command}::uuid,${worker}::uuid,'runBotTurn','','infinity')`;
    yield* sql`INSERT INTO bot_harness_turns(turn_id,bot_id,worker_id,command_id)
      VALUES(${turn}::uuid,${bot}::uuid,${worker}::uuid,${command}::uuid)`;
    yield* sql`INSERT INTO usage_counters(owner_user_id,subject_id,bot_id,bot_turn_id,provider,model,counter_id,first_bucket,totals)
      VALUES(${owner}::uuid,${`bot:${bot}`},${bot}::uuid,${turn}::uuid,'codex','common',${turn},${hour},
        '{"inputTokens":"35","reports":"1","unknownCostReports":"1"}')`;
  });
}

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const owner = Bun.randomUUIDv7();
  const other = Bun.randomUUIDv7();
  const studio = Bun.randomUUIDv7();
  const shared = Bun.randomUUIDv7();
  const foreign = Bun.randomUUIDv7();
  const project = Bun.randomUUIDv7();
  const bot = Bun.randomUUIDv7();
  const generation = Bun.randomUUIDv7();
  const missing = Bun.randomUUIDv7();
  const wrongOwner = Bun.randomUUIDv7();
  yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${owner}::uuid,'u@example.test','Owner','user'),(${other}::uuid,'v@example.test','Other','user')`;
  yield* sql`INSERT INTO usage_state(owner_user_id,computer_id,revision) VALUES(${owner}::uuid,'home',40)`;
  yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash)
    VALUES(${studio}::uuid,${owner}::uuid,'Studio','fixture'),(${shared}::uuid,NULL,'Shared','fixture'),(${foreign}::uuid,${other}::uuid,'Private','fixture')`;
  yield* sql`INSERT INTO projects(id,owner_user_id,name,slug) VALUES(${project}::uuid,${owner}::uuid,'Project','test')`;

  yield* threadCounter(sql, owner, project, studio, {
    inputTokens: "100",
    outputTokens: "10",
    cachedInputTokens: "12",
    cacheWriteInputTokens: "1",
    reasoningOutputTokens: "1",
    reportedCostUsd: 1.25,
    reports: "1",
  });
  yield* threadCounter(sql, owner, project, shared, {
    inputTokens: "80",
    outputTokens: "8",
    cachedInputTokens: "6",
    cacheWriteInputTokens: "4",
    reasoningOutputTokens: "2",
    estimatedCostUsd: 2.5,
    effectiveCostUsd: 2.5,
    reports: "1",
    unknownCostReports: "1",
    effectiveEstimatedCostReports: "1",
  });
  yield* botCounter(sql, owner, bot, shared);
  yield* sql`INSERT INTO worker_commands(id,worker_id,kind,payload,expires_at) VALUES
    (${generation}::uuid,${studio}::uuid,'generateText','','infinity'),(${wrongOwner}::uuid,${foreign}::uuid,'generateText','','infinity')`;

  for (const command of [generation, missing, wrongOwner])
    yield* sql`INSERT INTO usage_counters(owner_user_id,subject_id,provider,model,counter_id,first_bucket,totals)
      VALUES(${owner}::uuid,${`generation:${command}`},'codex','title',${command},${hour},'{"inputTokens":"10","reports":"1","unknownCostReports":"1"}')`;

  // One further thread watermark was purged after reporting partial costs.
  yield* sql`INSERT INTO usage_buckets(owner_user_id,bucket_start,activity_key,provider,model,input_tokens,output_tokens,cached_input_tokens,
    cache_write_input_tokens,reasoning_output_tokens,reported_cost_usd,estimated_cost_usd,effective_cost_usd,reports,unknown_cost_reports,
    unknown_estimated_cost_reports,unknown_effective_cost_reports,effective_reported_cost_reports,effective_estimated_cost_reports,revision)
    VALUES(${owner}::uuid,${hour},'thread','codex','common',200,20,18,5,3,2,2.75,3.75,3,2,2,1,1,1,35)`;
  yield* sql`INSERT INTO usage_buckets(owner_user_id,bucket_start,activity_key,bot_name,provider,model,input_tokens,reports,unknown_cost_reports,
    unknown_estimated_cost_reports,unknown_effective_cost_reports,revision) VALUES
    (${owner}::uuid,${hour},${`bot:${bot}`},'Routine','codex','common',35,1,1,1,1,38),
    (${owner}::uuid,${hour},'generation','','codex','title',30,3,3,3,3,40)`;
  yield* sql`INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint) VALUES(${owner}::uuid,'peer','Peer','','')`;
  yield* sql`INSERT INTO remote_usage_state(owner_user_id,node_id,cursor,has_more) VALUES(${owner}::uuid,'peer',75,false)`;
  yield* sql`INSERT INTO remote_usage_buckets(owner_user_id,node_id,bucket_start,provider,model,payload,revision)
    VALUES(${owner}::uuid,'peer',${hour},'codex','cached','{"totals":{"inputTokens":"90"}}',75)`;

  return { owner, other, studio, shared, bot, generation, missing };
});

const rollup = SqlClient.SqlClient.use(
  (sql) => sql`SELECT activity_key,model,
    sum(input_tokens) AS input_tokens,
    sum(output_tokens) AS output_tokens,
    sum(cached_input_tokens) AS cached_input_tokens,
    sum(cache_write_input_tokens) AS cache_write_input_tokens,
    sum(reasoning_output_tokens) AS reasoning_output_tokens,
    sum(reported_cost_usd) AS reported_cost_usd,
    sum(estimated_cost_usd) AS estimated_cost_usd,
    sum(effective_cost_usd) AS effective_cost_usd,
    sum(reports) AS reports,
    sum(unknown_cost_reports) AS unknown_cost_reports,
    sum(unknown_estimated_cost_reports) AS unknown_estimated_cost_reports,
    sum(unknown_effective_cost_reports) AS unknown_effective_cost_reports,
    sum(effective_reported_cost_reports) AS effective_reported_cost_reports,
    sum(effective_estimated_cost_reports) AS effective_estimated_cost_reports
  FROM usage_buckets GROUP BY activity_key,model ORDER BY activity_key,model`,
);

test.skipIf(!dockerAvailable)(
  "worker migration partitions only proven counters and replays changed groups",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);

    try {
      await runtime.runPromise(
        Migrator.make({})({
          loader: migrations.pipe(Effect.map((all) => all.filter(([id]) => id < 178))),
          table: "schema_migrations",
        }),
      );
      const { owner, other, studio, shared, bot, generation, missing } = await runtime.runPromise(seed);
      const before = await runtime.runPromise(rollup);
      expect(await runtime.runPromise(migrate)).toContainEqual([178, "usage_workers"]);
      expect(await runtime.runPromise(rollup)).toEqual(before);
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            expect(
              yield* sql`SELECT activity_key AS activity,usage_worker_name AS worker,input_tokens AS input,reports,revision
                FROM usage_activity_buckets WHERE reports>0 ORDER BY activity,worker`,
            ).toEqual([
              { activity: `bot:${bot}`, worker: "Shared", input: 35n, reports: 1n, revision: 41n },
              { activity: "generation", worker: "", input: 20n, reports: 2n, revision: 40n },
              { activity: "generation", worker: "Studio", input: 10n, reports: 1n, revision: 42n },
              { activity: "thread", worker: "", input: 20n, reports: 1n, revision: 35n },
              { activity: "thread", worker: "Shared", input: 80n, reports: 1n, revision: 41n },
              { activity: "thread", worker: "Studio", input: 100n, reports: 1n, revision: 41n },
            ]);
            expect(
              yield* sql`SELECT worker_key,reported_cost_usd,estimated_cost_usd,effective_cost_usd FROM usage_buckets
              WHERE activity_key='thread' ORDER BY worker_key='' DESC,reported_cost_usd DESC`,
            ).toEqual([
              { worker_key: "", reported_cost_usd: 0.75, estimated_cost_usd: 0.25, effective_cost_usd: 0 },
              { worker_key: studio, reported_cost_usd: 1.25, estimated_cost_usd: 0, effective_cost_usd: 1.25 },
              { worker_key: shared, reported_cost_usd: 0, estimated_cost_usd: 2.5, effective_cost_usd: 2.5 },
            ]);
            expect(yield* sql`SELECT cursor,has_more FROM remote_usage_state`).toEqual([
              { cursor: 0n, has_more: true },
            ]);
            expect(yield* sql`SELECT payload,revision FROM remote_usage_buckets`).toEqual([
              { payload: { totals: { inputTokens: "90" } }, revision: 75n },
            ]);

            // A rename is visible immediately. Loss of access preserves the accounting snapshot.
            yield* sql`UPDATE workers SET name='Renamed' WHERE id=${studio}::uuid`;
            expect(
              yield* sql`SELECT DISTINCT usage_worker_name AS name FROM usage_activity_buckets WHERE worker_key=${studio}`,
            ).toEqual([{ name: "Renamed" }]);
            yield* sql`UPDATE workers SET owner_user_id=${other}::uuid,name='Private now' WHERE id=${studio}::uuid`;
            expect(
              yield* sql`SELECT DISTINCT usage_worker_name AS name FROM usage_activity_buckets WHERE worker_key=${studio}`,
            ).toEqual([{ name: "Studio" }]);

            // The worker currently reporting a late sample must not move a retained (or unknown)
            // watermark's original usage to another worker, even when a speed is first discovered.
            for (const command of [generation, missing]) {
              yield* sql.withTransaction(
                recordUsage(
                  sql,
                  {
                    owner,
                    subject: `generation:${command}`,
                    counter: command,
                    model: "title",
                    provider: "codex",
                    activity: { key: "generation" },
                    worker: { id: shared, name: "Shared" },
                  },
                  create(UsageSchema, { scope: UsageScope.TURN, inputTokens: 15n, requestedServiceTier: "fast" }),
                  hour,
                ),
              );
            }

            expect(
              yield* sql`SELECT worker_key AS worker,requested_service_tier AS tier,input_tokens AS input,reports
                FROM usage_buckets WHERE model='title' AND reports>0 ORDER BY tier,worker`,
            ).toEqual([
              { worker: "", tier: "", input: 10n, reports: 1n },
              { worker: "", tier: "fast", input: 15n, reports: 1n },
              { worker: studio, tier: "fast", input: 15n, reports: 1n },
            ]);
            expect(yield* sql`SELECT revision FROM usage_state WHERE owner_user_id=${owner}::uuid`).toEqual([
              { revision: 48n },
            ]);
          }),
        ),
      );
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
