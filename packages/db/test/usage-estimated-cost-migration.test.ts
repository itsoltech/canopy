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
              yield* sql`INSERT INTO usage_buckets(owner_user_id,bucket_start,provider,model,reported_cost_usd,reports,unknown_cost_reports,revision)
          VALUES(${owner}::uuid,${hour},'codex','complete',7,2,0,1),(${owner}::uuid,${hour},'codex','mixed',11,4,2,2)`;
              yield* sql`INSERT INTO usage_counters(owner_user_id,subject_id,provider,model,counter_id,first_bucket,totals)
          VALUES(${owner}::uuid,'generation','codex','mixed','known',${hour},
            '{"inputTokens":"100","reports":"1","reportedCostUsd":3}'::jsonb),
          (${owner}::uuid,'generation','codex','mixed','unknown',${hour},
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
        SELECT model,reported_cost_usd,estimated_cost_usd,effective_cost_usd,unknown_estimated_cost_reports,
          unknown_effective_cost_reports,effective_reported_cost_reports,effective_estimated_cost_reports,revision
        FROM usage_buckets WHERE owner_user_id=${owner}::uuid ORDER BY model`,
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
          revision: 42n,
        },
      ]);
      // A live legacy watermark's next correction replaces only its prior effective contribution.
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          sql.withTransaction(
            recordUsage(
              sql,
              { owner, subject: "generation", provider: "codex", model: "mixed", counter: "known" },
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
        revision: 43n,
      });
      // A lower late reported quote replaces only the effective estimate, preserving both sums.
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          sql.withTransaction(
            recordUsage(
              sql,
              { owner, subject: "generation", provider: "codex", model: "mixed", counter: "known" },
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
        revision: 44n,
      });
      expect(await runtime.runPromise(migrate)).toEqual([]);
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  }, 60_000);
});
