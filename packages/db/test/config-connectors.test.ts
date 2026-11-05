import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres, type TestPostgres } from "../src/testing.ts";

describe.skipIf(!dockerAvailable)("migration 0077: connector configuration bootstrap", () => {
  let pg: TestPostgres;
  let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;
  const owner = crypto.randomUUID();
  const account = crypto.randomUUID();

  // Later migrations are not this test's business: bound the run to 0077.
  const migrate = Migrator.make({})({
    loader: Effect.map(migrations, (all) => all.filter(([n]) => n <= 77)),
    table: "schema_migrations",
  });

  const query = <A extends object>(text: string, params: readonly string[] = []) =>
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(text, params)));

  beforeAll(async () => {
    pg = await startPostgres();
    runtime = ManagedRuntime.make(pg.layer);
    await runtime.runPromise(
      Migrator.make({})({
        loader: Effect.map(migrations, (all) => all.filter(([n]) => n < 77)),
        table: "schema_migrations",
      }),
    );
    await query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,'connector@test','Owner','user')", [
      owner,
    ]);
    await query(
      `INSERT INTO connector_accounts(id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,
      credentials,status,last_used_at,updated_at) VALUES($1::uuid,$2::uuid,'custom','Work','unchanged','https://example.test/mcp',
      'http','headers','\\x010203','error','2031-01-02','2031-01-01')`,
      [account, owner],
    );
    await query(
      "INSERT INTO connector_oauth_apps(owner_user_id,connector_type,credentials) VALUES($1::uuid,'custom','\\x040506')",
      [owner],
    );
    expect((await runtime.runPromise(migrate)).map(([n, name]) => `${n}_${name}`)).toEqual(["77_config_connectors"]);
  }, 60_000);

  afterAll(async () => {
    await runtime?.dispose();
    await pg?.stop();
  });

  test("keeps encrypted accounts and local state; app timestamps seed gateway-side versions", async () => {
    const rows = await query<{
      credentials: Uint8Array;
      status: string;
      namespace: string;
      updated_at: Date;
      last_used_at: Date;
    }>("SELECT credentials,status,namespace,updated_at,last_used_at FROM connector_accounts WHERE id=$1::uuid", [
      account,
    ]);

    expect(rows[0]).toMatchObject({ credentials: new Uint8Array([1, 2, 3]), status: "error", namespace: "unchanged" });
    expect(new Date(rows[0]!.updated_at).toISOString()).toBe("2031-01-01T00:00:00.000Z");
    expect(new Date(rows[0]!.last_used_at).toISOString()).toBe("2031-01-02T00:00:00.000Z");

    const apps = await query<{ credentials: Uint8Array; updated_at: Date }>(
      "SELECT credentials,updated_at FROM connector_oauth_apps",
    );

    expect(apps[0]!.credentials).toEqual(new Uint8Array([4, 5, 6]));
    expect(new Date(apps[0]!.updated_at).getTime()).toBeGreaterThan(0);
    expect(await query("SELECT 1 FROM config_items WHERE kind IN ('connector','oauth_app')")).toHaveLength(0);
    expect(await runtime.runPromise(migrate)).toEqual([]);
  });
});
