import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient, type SqlConnection } from "effect/sql";
import { migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres, type TestPostgres } from "../src/testing.ts";

const owner = crypto.randomUUID();
const other = crypto.randomUUID();
const doc = crypto.randomUUID();
const skill = crypto.randomUUID();
const market = crypto.randomUUID();
const plugin = crypto.randomUUID();
let pg: TestPostgres;
let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;

const before = Migrator.make({})({
  loader: Effect.map(migrations, (all) => all.filter(([n]) => n < 76)),
  table: "schema_migrations",
});

const migrate = Migrator.make({})({
  loader: Effect.map(migrations, (all) => all.filter(([n]) => n <= 76)),
  table: "schema_migrations",
});

function query<A extends object = SqlConnection.Row>(text: string, params: unknown[] = []) {
  return runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(text, params)));
}

/** The hash linked computers use: SHA-256 of the stored JSON text. */
const textHash = async (expression: string, params: unknown[]) =>
  createHash("sha256")
    .update((await query<{ text: string }>(`SELECT (${expression})::text AS text`, params))[0]!.text)
    .digest("hex");

const artifact = (name: string) => JSON.stringify({ name, description: "d", checksum: "c", files: [] });

describe.skipIf(!dockerAvailable)("migration 0076: agent environment library versions by content", () => {
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
      "INSERT INTO instruction_documents(id,owner_user_id,revision,document,created_at) VALUES($1::uuid,$2::uuid,2,'{}','2031-01-01')",
      [doc, owner],
    );
    await query(
      `INSERT INTO instruction_document_versions(document_id,owner_user_id,revision,document,created_at)
      VALUES($1::uuid,$2::uuid,1,'{}','2031-01-01'),($1::uuid,$2::uuid,2,'{}','2031-01-05')`,
      [doc, owner],
    );
    await query(
      "INSERT INTO agent_skills(id,owner_user_id,definition,created_at) VALUES($1::uuid,$2::uuid,'{}','2031-02-01')",
      [skill, owner],
    );
    await query(
      `INSERT INTO agent_skill_versions(skill_id,owner_user_id,version,artifact,created_at)
      VALUES($1::uuid,$2::uuid,1,$3::jsonb,'2031-02-01'),($1::uuid,$2::uuid,2,$4::jsonb,'2031-02-03')`,
      [skill, owner, artifact("first"), artifact("second")],
    );
    await query(
      `INSERT INTO agent_marketplaces(id,owner_user_id,marketplace,created_at)
      VALUES($1::uuid,$2::uuid,'{"name":"team","plugins":[{"harnesses":["claude"]}]}','2031-03-01')`,
      [market, owner],
    );
    await query(
      `INSERT INTO agent_plugin_versions(owner_user_id,plugin_id,version,plugin)
      VALUES($1::uuid,$2::uuid,1,jsonb_build_object('assignment',jsonb_build_object('artifact',$3::jsonb)))`,
      [owner, plugin, artifact("review")],
    );
    expect((await runtime.runPromise(migrate)).map(([n, name]) => `${n}_${name}`)).toEqual([
      "76_config_agent_environment",
    ]);
  }, 90_000);
  afterAll(async () => {
    await runtime?.dispose();
    await pg?.stop();
  });

  test("existing items keep their last change time for the first merge", async () => {
    const time = async (table: string, id: string) =>
      new Date(
        (await query<{ updated_at: Date }>(`SELECT updated_at FROM ${table} WHERE id=$1::uuid`, [id]))[0]!.updated_at,
      ).toISOString();

    expect(await time("instruction_documents", doc)).toBe("2031-01-05T00:00:00.000Z");
    expect(await time("agent_skills", skill)).toBe("2031-02-03T00:00:00.000Z");
    expect(await time("agent_marketplaces", market)).toBe("2031-03-01T00:00:00.000Z");
  });

  test("versions and catalogs are named by the hash of their JSON text, also for new rows", async () => {
    const versions = await query<{ version: string; content_hash: string }>(
      "SELECT version::text,content_hash FROM agent_skill_versions WHERE skill_id=$1::uuid ORDER BY version",
      [skill],
    );

    expect(versions.map((v) => v.content_hash)).toEqual([
      await textHash("$1::jsonb", [artifact("first")]),
      await textHash("$1::jsonb", [artifact("second")]),
    ]);
    expect(
      (await query<{ content_hash: string }>("SELECT content_hash FROM agent_plugin_versions"))[0]?.content_hash,
    ).toBe(await textHash("$1::jsonb", [artifact("review")]));

    const catalog = await textHash(`'[{"harnesses":["claude"]}]'::jsonb`, []);
    expect(
      await query("SELECT content_hash FROM agent_marketplace_catalogs WHERE owner_user_id=$1::uuid", [owner]),
    ).toEqual([{ content_hash: catalog }]);

    await query(
      "INSERT INTO agent_skill_versions(skill_id,owner_user_id,version,artifact) VALUES($1::uuid,$2::uuid,3,$3::jsonb)",
      [skill, owner, artifact("third")],
    );
    expect(
      (await query<{ content_hash: string }>("SELECT content_hash FROM agent_skill_versions WHERE version=3"))[0]
        ?.content_hash,
    ).toBe(await textHash("$1::jsonb", [artifact("third")]));

    // A changed catalog is kept next to the earlier one; another owner's catalogs stay apart.
    await query(`UPDATE agent_marketplaces SET marketplace='{"name":"team","plugins":[]}' WHERE id=$1::uuid`, [market]);
    expect(await query("SELECT 1 FROM agent_marketplace_catalogs WHERE owner_user_id=$1::uuid", [owner])).toHaveLength(
      2,
    );
    expect(await query("SELECT 1 FROM agent_marketplace_catalogs WHERE owner_user_id=$1::uuid", [other])).toHaveLength(
      0,
    );
  });

  test("migration is idempotent", async () => {
    expect(await runtime.runPromise(migrate)).toHaveLength(0);
  });
});
