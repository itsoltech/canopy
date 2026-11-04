import { expect, test } from "bun:test";
import { ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { dockerAvailable, startPostgres } from "../src/testing.ts";

test.skipIf(!dockerAvailable)("template clones isolate data and schema; migration fixtures start empty", async () => {
  const first = await startPostgres({ migrated: true });
  const second = await startPostgres({ migrated: true });
  const empty = await startPostgres();
  const runtimes = [first, second, empty].map((pg) => ManagedRuntime.make(pg.layer));

  const query = (index: number, statement: string) =>
    runtimes[index]!.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe(statement)));

  try {
    await query(
      0,
      "INSERT INTO users (id, email, display_name, role) VALUES ('00000000-0000-0000-0000-000000000001', 'isolated@test', 'First', 'user')",
    );
    expect(await query(1, "SELECT id FROM users")).toEqual([]);
    await query(0, "CREATE TABLE isolation_probe (id int)");
    expect(await query(1, "SELECT to_regclass('isolation_probe') AS name")).toEqual([{ name: null }]);
    expect(await query(2, "SELECT to_regclass('schema_migrations') AS name")).toEqual([{ name: null }]);
    expect((await query(1, "SELECT * FROM schema_migrations")).length).toBeGreaterThan(0);
  } finally {
    for (const runtime of runtimes) await runtime.dispose();

    for (const pg of [first, second, empty]) await pg.stop();
  }
});
