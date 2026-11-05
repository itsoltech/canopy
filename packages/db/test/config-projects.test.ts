import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient, type SqlConnection } from "effect/sql";
import { migrations, migrate } from "../src/index.ts";
import { dockerAvailable, startPostgres, type TestPostgres } from "../src/testing.ts";

const owner = crypto.randomUUID();
const other = crypto.randomUUID();
const project = crypto.randomUUID();
const foreign = crypto.randomUUID();
const self = "a".repeat(64);
const peer = "b".repeat(64);
let pg: TestPostgres;
let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;

const before = Migrator.make({})({
  loader: Effect.map(migrations, (all) => all.filter(([n]) => n < 75)),
  table: "schema_migrations",
});

function query<A extends object = SqlConnection.Row>(text: string, params: unknown[] = []) {
  return runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(text, params)));
}

describe.skipIf(!dockerAvailable)("migration 0075: remaining 0050 projects", () => {
  beforeAll(async () => {
    pg = await startPostgres();
    runtime = ManagedRuntime.make(pg.layer);
    await runtime.runPromise(before);

    for (const id of [owner, other])
      await query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Owner','user')", [
        id,
        `${id}@example.test`,
      ]);
    await query(
      "INSERT INTO computer_identity(owner_user_id,node_id,name,certificate,private_key) VALUES($1::uuid,$2,'This computer','fixture','\\x00')",
      [owner, self],
    );
    await query(
      "INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint) VALUES($1::uuid,$2,'Laptop B','fixture','fixture')",
      [owner, peer],
    );
    await query(
      "INSERT INTO projects(id,owner_user_id,name,slug,created_at) VALUES($1::uuid,$2::uuid,'Local project','local','2031-01-01'),($3::uuid,$4::uuid,'Other owner','foreign','2031-01-01')",
      [project, owner, foreign, other],
    );
    await query(
      'INSERT INTO project_settings(project_id,settings,version,updated_by) VALUES($1::uuid,\'{"threadDefaults":{"workspaceId":"local-only"}}\',1,$2::uuid)',
      [project, owner],
    );
    await query(
      'INSERT INTO worktree_settings(owner_user_id,project_id,settings) VALUES($1::uuid,$2::uuid,\'{"location":"/local/tree","branchPrefix":"canopy"}\')',
      [owner, project],
    );
    await query(
      "INSERT INTO computer_shared_items(owner_user_id,item_key,shared,changed_at) VALUES($1::uuid,$2,true,'2031-01-02')",
      [owner, `project:${project}`],
    );
    await query(
      "INSERT INTO computer_shared_acks(owner_user_id,node_id,item_key,digest,shared) VALUES($1::uuid,$2,$3,'x',true)",
      [owner, peer, `project:${project}`],
    );

    for (const id of [project, foreign])
      await query(
        `INSERT INTO computer_shared_conflicts(owner_user_id,node_id,item_key,local_payload,remote_payload,remote_clock,remote_digest,remote_changed_at)
      VALUES($1::uuid,$2,$3,'{"name":"Local project"}','{"name":"Remote project"}','{}','x','2031-01-03')`,
        [owner, peer, `project:${id}`],
      );
    expect((await runtime.runPromise(migrate)).map(([n, name]) => `${n}_${name}`)).toEqual(["75_config_projects"]);
  }, 90_000);
  afterAll(async () => {
    await runtime?.dispose();
    await pg?.stop();
  });

  test("later project name wins, losing name remains restorable and local paths survive", async () => {
    expect((await query("SELECT name,config_deleted FROM projects WHERE id=$1::uuid", [project]))[0]).toMatchObject({
      name: "Remote project",
      config_deleted: false,
    });
    expect(
      await query("SELECT kind,global_id,field,value,reason FROM config_history WHERE owner_user_id=$1::uuid", [owner]),
    ).toEqual([{ kind: "project", global_id: project, field: "name", value: "Local project", reason: "merged" }]);
    expect(
      (
        await query<{ settings: object }>("SELECT settings FROM project_settings WHERE project_id=$1::uuid", [project])
      )[0]?.settings,
    ).toEqual({ threadDefaults: { workspaceId: "local-only" } });
    expect(
      (
        await query<{ settings: object }>("SELECT settings FROM worktree_settings WHERE project_id=$1::uuid", [project])
      )[0]?.settings,
    ).toEqual({ location: "/local/tree", branchPrefix: "canopy" });
    expect((await query("SELECT name FROM projects WHERE id=$1::uuid", [foreign]))[0]).toMatchObject({
      name: "Other owner",
    });
  });
  test("all 0050 tables are gone and migration is idempotent", async () => {
    for (const table of ["computer_shared_items", "computer_shared_acks", "computer_shared_conflicts"])
      expect(
        (await query<{ present: string | null }>("SELECT to_regclass($1)::text AS present", [table]))[0]?.present,
      ).toBeNull();
    expect(await runtime.runPromise(migrate)).toHaveLength(0);
  });
});
