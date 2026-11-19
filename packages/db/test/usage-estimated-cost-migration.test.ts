import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { UsageSchema, UsageScope } from "@canopy/contracts";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrations, migrate } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";
import { recordUsage } from "../../../apps/gateway/src/usage/accounting.ts";

describe.skipIf(!dockerAvailable)("usage estimate migration", () => {
  test("legacy partial buckets preserve reported amounts and live effective contributions without inventing prices", async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);
    const owner = Bun.randomUUIDv7();
    const botId = Bun.randomUUIDv7();
    const turnId = Bun.randomUUIDv7();
    const hour = new Date("2026-11-17T08:00:00Z");

    try {
      const oldMigrate = Migrator.make({})({
        loader: Effect.map(migrations, (entries) => entries.filter(([id]) => id < 165)),
        table: "schema_migrations",
      });

      await runtime.runPromise(oldMigrate);
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${owner}::uuid,${owner + "@test.invalid"},'Owner','user')`;
              yield* sql`INSERT INTO usage_state(owner_user_id,computer_id,revision) VALUES(${owner}::uuid,'source',40)`;
              yield* sql`INSERT INTO usage_buckets(owner_user_id,bucket_start,provider,model,input_tokens,reported_cost_usd,reports,unknown_cost_reports,revision)
          VALUES(${owner}::uuid,${hour},'codex','complete',0,7,2,0,1),(${owner}::uuid,${hour},'codex','mixed',300,11,4,2,2)`;
              yield* sql`INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance)
                VALUES(${botId}::uuid,${owner}::uuid,${botId},'{"name":"Release bot"}'::jsonb,'codex','native')`;
              yield* sql`INSERT INTO bot_turns(id,bot_id,client_request_id,input)
                VALUES(${turnId}::uuid,${botId}::uuid,${turnId},'Test')`;
              yield* sql`INSERT INTO usage_counters(owner_user_id,subject_id,bot_id,bot_turn_id,provider,model,counter_id,first_bucket,totals)
          VALUES(${owner}::uuid,${`bot:${botId}`},${botId}::uuid,${turnId}::uuid,'codex','mixed',${turnId},${hour},
            '{"inputTokens":"100","reports":"1","reportedCostUsd":3}'::jsonb),
          (${owner}::uuid,'generation',NULL,NULL,'codex','mixed','unknown',${hour},
            '{"inputTokens":"100","reports":"1","reportedCostUsd":4,"unknownCostReports":"1"}'::jsonb)`;
            }),
          ),
        ),
      );
      expect(await runtime.runPromise(migrate)).toContainEqual([165, "usage_estimated_cost"]);

      const rows = () =>
        runtime.runPromise(
          SqlClient.SqlClient.use(
            (sql) => sql`
        SELECT model,sum(reported_cost_usd) AS reported_cost_usd,sum(estimated_cost_usd) AS estimated_cost_usd,
          sum(effective_cost_usd) AS effective_cost_usd,sum(unknown_estimated_cost_reports)::bigint AS unknown_estimated_cost_reports,
          sum(unknown_effective_cost_reports)::bigint AS unknown_effective_cost_reports,
          sum(effective_reported_cost_reports)::bigint AS effective_reported_cost_reports,
          sum(effective_estimated_cost_reports)::bigint AS effective_estimated_cost_reports,max(revision) AS revision
        FROM usage_buckets WHERE owner_user_id=${owner}::uuid GROUP BY model ORDER BY model`,
          ),
        );

      expect(await rows()).toEqual([
        {
          model: "complete",
          reported_cost_usd: 7,
          estimated_cost_usd: 0,
          effective_cost_usd: 7,
          unknown_estimated_cost_reports: 2n,
          unknown_effective_cost_reports: 0n,
          effective_reported_cost_reports: 2n,
          effective_estimated_cost_reports: 0n,
          revision: 41n,
        },
        {
          model: "mixed",
          reported_cost_usd: 11,
          estimated_cost_usd: 0,
          effective_cost_usd: 3,
          unknown_estimated_cost_reports: 4n,
          unknown_effective_cost_reports: 3n,
          effective_reported_cost_reports: 1n,
          effective_estimated_cost_reports: 0n,
          revision: 84n,
        },
      ]);

      const activityRows = () =>
        runtime.runPromise(
          SqlClient.SqlClient.use(
            (sql) => sql`
            SELECT activity_key,activity_bot_name,input_tokens,reports,effective_cost_usd,unknown_effective_cost_reports
            FROM usage_activity_buckets WHERE owner_user_id=${owner}::uuid AND model='mixed' ORDER BY activity_key`,
          ),
        );

      expect(await activityRows()).toEqual([
        {
          activity_key: `bot:${botId}`,
          activity_bot_name: "Release bot",
          input_tokens: 100n,
          reports: 1n,
          effective_cost_usd: 3,
          unknown_effective_cost_reports: 0n,
        },
        {
          activity_key: "generation",
          activity_bot_name: "",
          input_tokens: 100n,
          reports: 1n,
          effective_cost_usd: 0,
          unknown_effective_cost_reports: 1n,
        },
        {
          activity_key: "unattributed",
          activity_bot_name: "",
          input_tokens: 100n,
          reports: 2n,
          effective_cost_usd: 0,
          unknown_effective_cost_reports: 2n,
        },
      ]);

      const botIdentity = {
        owner,
        worker: { id: "", name: "" },
        subject: `bot:${botId}`,
        provider: "codex",
        model: "mixed",
        counter: turnId,
        botId,
        activity: { key: `bot:${botId}`, botName: "Release bot" },
      };

      // A live legacy watermark's next correction replaces only its prior effective contribution.
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          sql.withTransaction(
            recordUsage(
              sql,
              botIdentity,
              create(UsageSchema, {
                scope: UsageScope.TURN,
                inputTokens: 200n,
                estimatedCostUsd: 5,
                pricingVersion: "quote",
              }),
              hour,
            ),
          ),
        ),
      );
      expect((await rows())[1]).toMatchObject({
        reported_cost_usd: 11,
        estimated_cost_usd: 5,
        effective_cost_usd: 5,
        unknown_estimated_cost_reports: 3n,
        unknown_effective_cost_reports: 3n,
        effective_reported_cost_reports: 0n,
        effective_estimated_cost_reports: 1n,
        revision: 85n,
      });
      // A lower late reported quote replaces only the effective estimate, preserving both sums.
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          sql.withTransaction(
            recordUsage(
              sql,
              botIdentity,
              create(UsageSchema, { scope: UsageScope.TURN, inputTokens: 200n, reportedCostUsd: 4 }),
              hour,
            ),
          ),
        ),
      );
      expect((await rows())[1]).toMatchObject({
        reported_cost_usd: 12,
        estimated_cost_usd: 5,
        effective_cost_usd: 4,
        unknown_estimated_cost_reports: 3n,
        unknown_effective_cost_reports: 3n,
        effective_reported_cost_reports: 1n,
        effective_estimated_cost_reports: 0n,
        revision: 86n,
      });
      expect((await activityRows())[0]).toMatchObject({ input_tokens: 200n, reports: 1n, effective_cost_usd: 4 });
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            yield* sql`DELETE FROM bot_turns WHERE id=${turnId}::uuid`;
            yield* sql`DELETE FROM bots WHERE id=${botId}::uuid`;
          }),
        ),
      );
      expect((await activityRows())[0]).toMatchObject({ activity_bot_name: "Release bot", input_tokens: 200n });
      expect(await runtime.runPromise(migrate)).toEqual([]);
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  }, 60_000);
});
