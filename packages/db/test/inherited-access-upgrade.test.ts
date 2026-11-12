import { expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrations, migrate } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";

const through = (last: number) =>
  Migrator.make({})({
    loader: migrations.pipe(Effect.map((all) => all.filter(([id]) => id <= last))),
    table: "schema_migrations",
  });

test.skipIf(!dockerAvailable)(
  "inherited bot access upgrades preserve explicit owner choices",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);

    try {
      // Apply a contiguous prefix so a later migration cannot make the migrator skip 0125.
      await runtime.runPromise(through(124));
      const user = Bun.randomUUIDv7();
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${user}::uuid,'access-upgrade@test.local','Owner','user')`;

          for (const mode of [null, "same_bot", "user_default", "ask", "read_only", "full_auto", "full_access"]) {
            const id = Bun.randomUUIDv7();
            const config = { name: mode ?? "missing", ...(mode && { threadPermission: mode }) };
            yield* sql`INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance)
          VALUES(${id}::uuid,${user}::uuid,${id},${JSON.stringify(config)}::jsonb,'codex','native')`;
          }
        }),
      );
      const applied = await runtime.runPromise(through(125));
      expect(applied.map(([, name]) => name)).toEqual(["inherited_access_mode"]);

      const modes = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql<{ name: string; mode: string }>`SELECT configuration->>'name' AS name,
        configuration->>'threadPermission' AS mode FROM bots WHERE owner_user_id=${user}::uuid`;
        }),
      );

      expect(Object.fromEntries(modes.map((row) => [row.name, row.mode]))).toEqual({
        missing: "user_default",
        same_bot: "user_default",
        user_default: "user_default",
        ask: "ask",
        read_only: "read_only",
        full_auto: "full_auto",
        full_access: "full_access",
      });
      expect(await runtime.runPromise(through(125))).toEqual([]);
      await runtime.runPromise(migrate);
      expect(await runtime.runPromise(migrate)).toEqual([]);
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
