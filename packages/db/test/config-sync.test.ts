import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient, type SqlConnection } from "effect/sql";
import { migrate, migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres, type TestPostgres } from "../src/testing.ts";

const owner = crypto.randomUUID();
const other = crypto.randomUUID();
const self = "a".repeat(64);
const peer = "b".repeat(64);
let pg: TestPostgres;
let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;

const before = Migrator.make({})({
  loader: Effect.map(migrations, (all) => all.filter(([n]) => n < 73)),
  table: "schema_migrations",
});

function query<A extends object = SqlConnection.Row>(text: string, params: unknown[] = []) {
  return runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(text, params)));
}

describe.skipIf(!dockerAvailable)("migration 0073: account configuration and pending 0050 conflicts", () => {
  beforeAll(async () => {
    pg = await startPostgres();
    runtime = ManagedRuntime.make(pg.layer);
    await runtime.runPromise(before);
    await query(
      `INSERT INTO users(id,email,display_name,role) VALUES
      ($1::uuid,'config@example.test','Owner','user'),($2::uuid,'other@example.test','Other','user')`,
      [owner, other],
    );
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
      `INSERT INTO user_settings(user_id,settings,version,updated_at) VALUES($1::uuid,$2::jsonb,1,'2031-01-02'),
      ($3::uuid,'{"timezone":"Australia/Sydney"}',1,'2031-01-02')`,
      [
        owner,
        JSON.stringify({
          appearance: { accent: "ACCENT_THEME_OCEAN", sidebarWidth: 319, sidebarCollapsed: true },
          timezone: "Europe/Warsaw",
          threadDefaults: { workspaceId: "local-workspace", permissionMode: "PERMISSION_MODE_ASK" },
          general: { confirmDelete: false },
          composer: { runningDelivery: "MESSAGE_DELIVERY_QUEUE" },
          cliUpdates: { intervalMinutes: 60 },
          workerGatewayUrl: "https://local.invalid",
          sidebar: { pinnedThreadIds: ["thread-local", `thread-remote~${peer.slice(0, 16)}`] },
          attachmentLimits: { maxFiles: 5 },
        }),
        other,
      ],
    );

    for (const section of ["appearance", "timezone"]) {
      await query(
        `INSERT INTO computer_shared_items(owner_user_id,item_key,shared,changed_at)
        VALUES($1::uuid,$2,true,'2031-01-02')`,
        [owner, `settings:${section}`],
      );
      await query(
        `INSERT INTO computer_shared_acks(owner_user_id,node_id,item_key,digest,shared)
        VALUES($1::uuid,$2,$3,'fixture',true)`,
        [owner, peer, `settings:${section}`],
      );
      await query(
        `INSERT INTO computer_shared_conflicts(owner_user_id,node_id,item_key,local_payload,
        remote_payload,remote_clock,remote_digest,remote_changed_at) VALUES($1::uuid,$2,$3,$4::jsonb,$5::jsonb,'{}','fixture',$6)`,
        [
          owner,
          peer,
          `settings:${section}`,
          JSON.stringify(
            section === "appearance"
              ? { accent: "ACCENT_THEME_OCEAN", sidebarWidth: 319 }
              : { timezone: "Europe/Warsaw" },
          ),
          JSON.stringify(
            section === "appearance" ? { accent: "ACCENT_THEME_SAGE", sidebarWidth: 111 } : { timezone: "Asia/Tokyo" },
          ),
          section === "appearance" ? "2031-01-03" : "2031-01-01",
        ],
      );
    }

    await query(
      `INSERT INTO computer_shared_items(owner_user_id,item_key,shared) VALUES($1::uuid,'project:preserved',true)`,
      [owner],
    );
    expect((await runtime.runPromise(migrate)).map(([n, name]) => `${n}_${name}`)).toContain("73_config_sync");
  }, 90_000);

  afterAll(async () => {
    await runtime?.dispose();
    await pg?.stop();
  });

  test("newer remote and newer local values win without replacing computer preferences", async () => {
    const rows = await query<{ settings: { timezone: string; appearance: object } }>(
      "SELECT settings FROM user_settings WHERE user_id=$1::uuid",
      [owner],
    );

    expect(rows[0]!.settings).toMatchObject({
      timezone: "Europe/Warsaw",
      appearance: { accent: "ACCENT_THEME_SAGE", sidebarWidth: 319, sidebarCollapsed: true },
    });

    const record = (
      await query<{ fields: Record<string, { value: unknown; hlc: string }> }>(
        "SELECT fields FROM config_items WHERE owner_user_id=$1::uuid AND kind='settings'",
        [owner],
      )
    )[0]!;

    expect(record.fields["appearance.accent"]?.value).toBe("ACCENT_THEME_SAGE");
    expect(record.fields["timezone"]?.value).toBe("Europe/Warsaw");
    expect(record.fields["cliUpdates.intervalMinutes"]?.value).toBe(60);
    expect(record.fields["general.confirmDelete"]?.value).toBe(false);
    expect(record.fields["sidebar.pinnedThreadIds"]?.value).toEqual([`thread-local@${self}`, `thread-remote@${peer}`]);
    expect(JSON.stringify(record.fields)).not.toContain("sidebarWidth");
    expect(JSON.stringify(record.fields)).not.toContain("workspaceId");
    expect(JSON.stringify(record.fields)).not.toContain("workerGatewayUrl");
    expect(JSON.stringify(record.fields)).not.toContain("attachmentLimits");
    expect(await query("SELECT * FROM config_items WHERE owner_user_id=$1::uuid", [other])).toHaveLength(0);
  });

  test("losing shared leaves become durable Restore notices and legacy settings metadata is removed", async () => {
    const history = await query<{ field: string; value: unknown; state: string; reason: string }>(
      "SELECT field,value,state,reason FROM config_history WHERE owner_user_id=$1::uuid ORDER BY field",
      [owner],
    );

    expect(history).toEqual([
      { field: "appearance.accent", value: "ACCENT_THEME_OCEAN", state: "open", reason: "merged" },
      { field: "timezone", value: "Asia/Tokyo", state: "open", reason: "merged" },
    ]);

    for (const table of ["computer_shared_items", "computer_shared_acks", "computer_shared_conflicts"])
      expect(await query(`SELECT * FROM ${table} WHERE item_key LIKE 'settings:%'`)).toHaveLength(0);
    expect(await query("SELECT * FROM computer_shared_items WHERE item_key='project:preserved'")).toHaveLength(1);
    expect(await runtime.runPromise(migrate)).toHaveLength(0);
    expect(await query("SELECT * FROM config_history")).toHaveLength(2);
  });

  test("existing links default to consent and unlink removes only their checkpoint", async () => {
    expect((await query("SELECT share_config,peer_share_config FROM computer_peers"))[0]).toMatchObject({
      share_config: true,
      peer_share_config: true,
    });
    await query("INSERT INTO config_peer_cursors(owner_user_id,node_id,cursor) VALUES($1::uuid,$2,'epoch:1')", [
      owner,
      peer,
    ]);
    await query("DELETE FROM computer_peers WHERE owner_user_id=$1::uuid AND node_id=$2", [owner, peer]);
    expect(await query("SELECT * FROM config_peer_cursors")).toHaveLength(0);
    expect(await query("SELECT * FROM config_items")).toHaveLength(1);
    expect(await query("SELECT * FROM config_history")).toHaveLength(2);
  });
});
