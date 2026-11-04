import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient, type SqlConnection } from "effect/sql";
import { migrate, migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres, type TestPostgres } from "../src/testing.ts";

describe.skipIf(!dockerAvailable)("migration 0041: bot MCP registry to connector accounts", () => {
  let pg: TestPostgres;
  let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;

  const owner = Bun.randomUUIDv7(),
    foreign = Bun.randomUUIDv7(),
    bot = Bun.randomUUIDv7(),
    foreignBot = Bun.randomUUIDv7(),
    server = Bun.randomUUIDv7(),
    disabled = Bun.randomUUIDv7(),
    secret = Bun.randomUUIDv7();

  const query = <A extends object = SqlConnection.Row>(text: string, ...params: unknown[]) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(text, params);
      }),
    );

  beforeAll(async () => {
    pg = await startPostgres();
    runtime = ManagedRuntime.make(pg.layer);
    await runtime.runPromise(
      Migrator.make({})({
        loader: Effect.map(migrations, (all) => all.filter(([n]) => n < 41)),
        table: "schema_migrations",
      }),
    );
    await query(
      "INSERT INTO users(id,email,display_name,role) VALUES ($1,'connectors@test','Owner','user'),($2,'foreign@test','Foreign','user')",
      owner,
      foreign,
    );
    await query(
      "INSERT INTO secrets(id,owner_user_id,name,ciphertext,key_id,created_by) VALUES ($1,$2,'bot-mcp-fixture','\\x010203','env-v1',$2)",
      secret,
      owner,
    );
    await query(
      "INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance) VALUES ($1,$2,'b','{}','codex','native'),($3,$4,'f','{}','codex','native')",
      bot,
      owner,
      foreignBot,
      foreign,
    );
    await query(
      "INSERT INTO bot_mcp_servers(id,owner_user_id,name,url,transport,headers,enabled) VALUES ($1,$2,'work','https://example.com/mcp','http',$3::jsonb,true),($4,$2,'disabled','https://example.com/sse','sse','{}',false)",
      server,
      owner,
      JSON.stringify({ Authorization: { secretRef: secret } }),
      disabled,
    );
    await query("INSERT INTO bot_mcp_connections(bot_id,server_id) VALUES ($1,$2),($3,$2)", bot, server, foreignBot);
    await runtime.runPromise(migrate);
  }, 60_000);
  afterAll(async () => {
    await runtime?.dispose();
    pg?.stop();
  });
  test("keeps account ids and encrypted secret references, migrates only owned attachments, grants no workers", async () => {
    const rows = await query<{
      id: string;
      connector_type: string;
      status: string;
      all_workers: boolean;
      all_bots: boolean;
      credentials: unknown;
      legacy_headers: unknown;
    }>("SELECT * FROM connector_accounts ORDER BY name");

    expect(rows.map((r) => [r.id, r.connector_type, r.status, r.all_workers, r.all_bots, r.credentials])).toEqual([
      [disabled, "custom", "disconnected", false, false, null],
      [server, "custom", "connected", false, false, null],
    ]);
    expect(rows[1]!.legacy_headers).toEqual({ Authorization: { secretRef: secret } });
    expect(await query("SELECT account_id,bot_id FROM connector_bot_grants")).toEqual([
      { account_id: server, bot_id: bot },
    ]);
    expect(await query("SELECT * FROM connector_worker_grants")).toHaveLength(0);
    expect(
      (await query<{ ciphertext: Uint8Array }>("SELECT ciphertext FROM secrets WHERE id=$1", secret))[0]!.ciphertext,
    ).toEqual(new Uint8Array([1, 2, 3]));
  });
});
