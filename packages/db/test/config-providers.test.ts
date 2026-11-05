import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient, type SqlConnection } from "effect/sql";
import { migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres, type TestPostgres } from "../src/testing.ts";

const owner = crypto.randomUUID();
const self = "a".repeat(64);
const peer = "b".repeat(64);
let pg: TestPostgres;
let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;

const before = Migrator.make({})({
  loader: Effect.map(migrations, (all) => all.filter(([n]) => n < 74)),
  table: "schema_migrations",
});

const migrate = Migrator.make({})({
  loader: Effect.map(migrations, (all) => all.filter(([n]) => n <= 74)),
  table: "schema_migrations",
});

function query<A extends object = SqlConnection.Row>(text: string, params: unknown[] = []) {
  return runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(text, params)));
}

type Payload = Record<string, string | string[]>;

async function conflict(key: string, local: Payload, remote: Payload, remoteAt: string) {
  await query(
    "INSERT INTO computer_shared_items(owner_user_id,item_key,shared,changed_at) VALUES($1::uuid,$2,true,'2031-01-02')",
    [owner, key],
  );
  await query(
    "INSERT INTO computer_shared_acks(owner_user_id,node_id,item_key,digest,shared) VALUES($1::uuid,$2,$3,'x',true)",
    [owner, peer, key],
  );
  await query(
    `INSERT INTO computer_shared_conflicts(owner_user_id,node_id,item_key,local_payload,remote_payload,remote_clock,
    remote_digest,remote_changed_at) VALUES($1::uuid,$2,$3,$4::jsonb,$5::jsonb,'{}','x',$6)`,
    [owner, peer, key, JSON.stringify(local), JSON.stringify(remote), remoteAt],
  );
}

describe.skipIf(!dockerAvailable)("migration 0074: pending 0050 instance and model questions", () => {
  beforeAll(async () => {
    pg = await startPostgres();
    runtime = ManagedRuntime.make(pg.layer);
    await runtime.runPromise(before);
    await query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,'p@example.test','Owner','user')", [
      owner,
    ]);
    await query(
      `INSERT INTO computer_identity(owner_user_id,node_id,name,certificate,private_key)
      VALUES($1::uuid,$2,'This computer','fixture','\\x00')`,
      [owner, self],
    );
    await query(
      `INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint)
      VALUES($1::uuid,$2,'Laptop B','fixture','fixture')`,
      [owner, peer],
    );
    await query(
      `INSERT INTO provider_instances(harness,id,label,kind,base_url,accent_color,favorites,updated_at)
      VALUES('codex','team','Local name','endpoint','http://127.0.0.1:1','#111111','{local-model}','2031-01-02')`,
    );
    await conflict(
      "instance:codex:team",
      { label: "Local name", kind: "endpoint", baseUrl: "http://127.0.0.1:1", accentColor: "#111111", apiKey: "t1" },
      { label: "Remote name", kind: "endpoint", baseUrl: "http://127.0.0.1:2", accentColor: "#222222", apiKey: "t2" },
      "2031-01-03",
    );
    await conflict(
      "models:codex:team",
      { favorites: ["local-model"], hidden: [], shown: [], custom: [] },
      { favorites: ["remote-model"], hidden: ["x"], shown: [], custom: [] },
      "2031-01-01",
    );
    await query(
      "INSERT INTO computer_shared_items(owner_user_id,item_key,shared) VALUES($1::uuid,'project:preserved',true)",
      [owner],
    );
    expect((await runtime.runPromise(migrate)).map(([n, name]) => `${n}_${name}`)).toEqual(["74_config_providers"]);
  }, 90_000);

  afterAll(async () => {
    await runtime?.dispose();
    await pg?.stop();
  });

  test("the later value wins; the other one, and a remote connection, stay as Restore", async () => {
    const instance = (
      await query<{ label: string; accent_color: string; base_url: string; favorites: string[]; updated_at: Date }>(
        "SELECT label,accent_color,base_url,favorites,updated_at FROM provider_instances WHERE id='team'",
      )
    )[0]!;

    expect(instance).toMatchObject({
      label: "Remote name",
      accent_color: "#222222",
      base_url: "http://127.0.0.1:1",
      favorites: ["local-model"],
    });
    expect(new Date(instance.updated_at).toISOString()).toBe("2031-01-03T00:00:00.000Z");

    const history = await query<{ field: string; value: unknown; node_id: string; reason: string }>(
      "SELECT field,value,node_id,reason FROM config_history WHERE global_id='codex:team' ORDER BY field,node_id",
    );

    expect(history).toEqual(
      [
        { field: "accentColor", value: "#111111", node_id: self, reason: "merged" },
        { field: "baseUrl", value: "http://127.0.0.1:1", node_id: self, reason: "merged" },
        { field: "baseUrl", value: "http://127.0.0.1:2", node_id: peer, reason: "merged" },
        { field: "favorites", value: ["remote-model"], node_id: peer, reason: "merged" },
        { field: "hidden", value: ["x"], node_id: peer, reason: "merged" },
        { field: "kind", value: "endpoint", node_id: self, reason: "merged" },
        { field: "label", value: "Local name", node_id: self, reason: "merged" },
        { field: "shown", value: [], node_id: peer, reason: "merged" },
        { field: "custom", value: [], node_id: peer, reason: "merged" },
      ].sort((x, y) => x.field.localeCompare(y.field) || x.node_id.localeCompare(y.node_id)),
    );
    expect(JSON.stringify(history)).not.toMatch(/"t1"|"t2"/);
  });

  test("0050 metadata of instances and models is gone; other kinds and later runs are untouched", async () => {
    for (const table of ["computer_shared_items", "computer_shared_acks", "computer_shared_conflicts"])
      expect(
        await query(`SELECT * FROM ${table} WHERE item_key LIKE 'instance:%' OR item_key LIKE 'models:%'`),
      ).toHaveLength(0);
    expect(await query("SELECT * FROM computer_shared_items WHERE item_key='project:preserved'")).toHaveLength(1);
    expect(await query("SELECT * FROM config_secrets")).toHaveLength(0);
    expect(await runtime.runPromise(migrate)).toHaveLength(0);
  });
});
