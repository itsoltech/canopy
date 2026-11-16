import { expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrations, migrate } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";

const hopBounds = {
  agent_bus_calls: 1,
  background_task_notes: 1,
  bot_routines: 1,
  bot_thread_watches: 1,
  bot_turns: 0,
  bot_wakeups: 1,
  computer_agent_calls: 0,
  pr_check_notes: 1,
  pr_check_watches: 1,
  schedules: 0,
  turn_steers: 0,
  turns: 0,
};

interface HopColumn {
  table_name: string;
  data_type: string;
  not_null: boolean;
  default_value: string | null;
  definition: string;
}

const hopColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql<HopColumn>`SELECT t.relname AS table_name, a.atttypid::regtype::text AS data_type,
      a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_value,
      pg_get_constraintdef(c.oid) AS definition
    FROM pg_class t
    JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'hops' AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = t.oid AND d.adnum = a.attnum
    LEFT JOIN pg_constraint c ON c.conrelid = t.oid AND c.conname = t.relname || '_hops_check'
    WHERE t.relkind = 'r' ORDER BY t.relname`;
});

const otherInvariants = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql<{ table_name: string; name: string; definition: string }>`
    SELECT t.relname AS table_name, c.conname AS name, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
      WHERE c.conname <> t.relname || '_hops_check'
    UNION ALL
    SELECT t.relname, g.tgname, pg_get_triggerdef(g.oid)
      FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
      WHERE NOT g.tgisinternal
    ORDER BY table_name, name, definition`;
});

const seedLegacyBotTurn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const user = Bun.randomUUIDv7();
  const bot = Bun.randomUUIDv7();
  const turn = Bun.randomUUIDv7();
  yield* sql`INSERT INTO users(id,email,display_name,role)
    VALUES(${user}::uuid,'hop-upgrade@test.local','Owner','user')`;
  yield* sql`INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance)
    VALUES(${bot}::uuid,${user}::uuid,${bot},'{}','codex','native')`;
  yield* sql`INSERT INTO bot_turns(id,bot_id,client_request_id,input,hops)
    VALUES(${turn}::uuid,${bot}::uuid,${turn},'Continue',8)`;

  return turn;
});

const probeBounds = (column: HopColumn, minimum: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Table names and CHECK definitions come only from this isolated database's catalog.
    const table = `hop_probe_${column.table_name}`;
    yield* sql.unsafe(`CREATE TABLE ${table} (hops integer ${column.not_null ? "NOT NULL" : ""} ${column.definition})`);
    yield* sql.unsafe(`INSERT INTO ${table}(hops) VALUES ($1), (100), (256), (257), (40000)`, [minimum]);
    expect((yield* Effect.exit(sql.unsafe(`INSERT INTO ${table}(hops) VALUES ($1)`, [minimum - 1])))._tag).toBe(
      "Failure",
    );
    const nullable = yield* Effect.exit(sql.unsafe(`INSERT INTO ${table}(hops) VALUES (NULL)`));
    expect(nullable._tag).toBe(column.not_null ? "Failure" : "Success");
    yield* sql.unsafe(`DROP TABLE ${table}`);
  });

test.skipIf(!dockerAvailable)(
  "hop policy upgrade preserves data and invariants while allowing full chain metadata",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);

    try {
      const previous = Migrator.make({})({
        loader: migrations.pipe(Effect.map((all) => all.filter(([id]) => id < 160))),
        table: "schema_migrations",
      });

      const upgrade = Migrator.make({})({
        loader: migrations.pipe(Effect.map((all) => all.filter(([id]) => id <= 160))),
        table: "schema_migrations",
      });

      await runtime.runPromise(previous);
      const turn = await runtime.runPromise(seedLegacyBotTurn);
      const before = await runtime.runPromise(hopColumns);
      const invariants = await runtime.runPromise(otherInvariants);
      expect(await runtime.runPromise(upgrade)).toEqual([[160, "agent_hop_policy"]]);
      expect(await runtime.runPromise(otherInvariants)).toEqual(invariants);
      const after = await runtime.runPromise(hopColumns);
      expect(after.map((column) => column.table_name)).toEqual(Object.keys(hopBounds));
      expect(after.map(({ table_name, not_null, default_value }) => ({ table_name, not_null, default_value }))).toEqual(
        before.map(({ table_name, not_null, default_value }) => ({ table_name, not_null, default_value })),
      );

      for (const column of after) {
        expect(column.data_type).toBe("integer");
        expect(column.not_null).toBe(column.table_name !== "agent_bus_calls");
        const minimum = Object.entries(hopBounds).find(([table]) => table === column.table_name)?.[1];

        if (minimum === undefined) throw new Error(`Unexpected hops column: ${column.table_name}`);

        await runtime.runPromise(probeBounds(column, minimum));
      }

      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect(yield* sql`SELECT hops, input FROM bot_turns WHERE id = ${turn}::uuid`).toEqual([
            { hops: 8, input: "Continue" },
          ]);

          for (const hops of [100, 256, 257, 40000]) {
            expect(yield* sql`UPDATE bot_turns SET hops = ${hops} WHERE id = ${turn}::uuid RETURNING hops`).toEqual([
              { hops },
            ]);
          }
        }),
      );
      expect(await runtime.runPromise(upgrade)).toEqual([]);
      await runtime.runPromise(migrate);
      expect(await runtime.runPromise(migrate)).toEqual([]);
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
