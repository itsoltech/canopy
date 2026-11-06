import { expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrations, migrate } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";

test.skipIf(!dockerAvailable)(
  "upgraded full-auto bots keep Ask first; explicit owner settings survive",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);

    try {
      const previous = Migrator.make({})({
        loader: migrations.pipe(Effect.map((all) => all.filter(([id]) => id < 90))),
        table: "schema_migrations",
      });

      await runtime.runPromise(previous);
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const user = Bun.randomUUIDv7();
          yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${user}::uuid, 'upgrade@test.local', 'Owner', 'user')`;

          for (const [id, config] of [
            [Bun.randomUUIDv7(), { approvalPolicy: "full_auto" }],
            [Bun.randomUUIDv7(), { approvalPolicy: "safe" }],
            [Bun.randomUUIDv7(), { approvalPolicy: "full_auto", threadPermission: "read_only" }],
          ] as const) {
            yield* sql`INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance)
          VALUES(${id}::uuid,${user}::uuid,${id},${JSON.stringify(config)}::jsonb,'codex','native')`;
          }
        }),
      );
      expect(await runtime.runPromise(migrate)).toEqual([[90, "bot_approval_defaults"]]);

      const rows = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql<{
            mode: string;
          }>`SELECT configuration ->> 'threadPermission' AS mode FROM bots ORDER BY created_at, id`;
        }),
      );

      expect(rows.map((r) => r.mode)).toEqual(["ask", "ask", "read_only"]);
      expect(await runtime.runPromise(migrate)).toEqual([]);
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
