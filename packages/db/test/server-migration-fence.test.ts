import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "../src/testing.ts";
import { query, startSchemaDb, stopSchemaDb } from "./support/schema.ts";

/** The empty-target reservation (0147) must guard every table a migration could import into. A table that a
 * later migration adds fails here until it is runtime, fenced (server_migration_install_fences) or covered by
 * a NOT NULL foreign key to a fenced table. */
describe.skipIf(!dockerAvailable)("server migration fence coverage", () => {
  beforeAll(startSchemaDb, 60_000);
  afterAll(stopSchemaDb);

  test("every table is runtime, fenced with the planned events, or covered by a fenced parent", async () => {
    const tables = await query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`,
    );

    const runtime = (await query<{ names: string[] }>("SELECT server_migration_runtime_tables() AS names"))[0]!.names;
    const plan = await query<{ name: string; plan: string }>("SELECT * FROM server_migration_fence_plan()");

    const triggers = await query<{ name: string; events: string }>(
      `SELECT c.relname AS name, concat_ws(',',
          CASE WHEN t.tgtype & 4 <> 0 THEN 'insert' END,
          CASE WHEN t.tgtype & 8 <> 0 THEN 'delete' END,
          CASE WHEN t.tgtype & 16 <> 0 THEN 'update' END) AS events
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'server_migration_fence'`,
    );

    const planned = new Map(plan.map((row) => [row.name, row.plan]));
    const installed = new Map(triggers.map((row) => [row.name, row.events]));
    const unclassified = tables.map((t) => t.name).filter((name) => !runtime.includes(name) && !planned.has(name));
    expect(unclassified).toEqual([]);

    for (const [name, kind] of planned) {
      if (kind === "all") expect([name, installed.get(name)]).toEqual([name, "insert,delete,update"]);
      else if (kind === "insert") expect([name, installed.get(name)]).toEqual([name, "insert"]);
      else expect([name, installed.get(name)]).toEqual([name, undefined]);
    }

    // The hot write paths stay trigger-free: their rows need a fenced parent.
    for (const hot of ["thread_events", "thread_items", "turns", "worker_commands", "bot_messages"])
      expect([hot, planned.get(hot)]).toEqual([hot, "covered"]);

    // Bootstrap tables are guarded for every change; roots for inserts.
    for (const name of ["users", "projects", "provider_instances", "config_items"])
      expect(planned.get(name)).toBe("all");

    for (const name of ["threads", "bots", "workers", "secrets", "user_settings"])
      expect(planned.get(name)).toBe("insert");
  });

  test("default rows are exactly what a server creates; edited rows are data", async () => {
    const isDefault = async (table: string, row: string) =>
      (await query<{ ok: boolean }>("SELECT server_migration_default_row($1, $2::jsonb) AS ok", [table, row]))[0]!.ok;

    const native = {
      harness: "codex",
      id: "native",
      label: "",
      kind: "native",
      base_url: "",
      api_key: null,
      env: [],
      runtime: {},
      accent_color: "",
      favorites: [],
      hidden_models: [],
      shown_models: [],
      custom_models: [],
      all_workers: true,
      built_in: true,
      revision: 1,
      created_by: null,
      proxy_id: null,
    };

    expect(await isDefault("provider_instances", JSON.stringify(native))).toBe(true);
    expect(await isDefault("provider_instances", JSON.stringify({ ...native, favorites: ["gpt-5.5"] }))).toBe(false);
    expect(await isDefault("provider_instances", JSON.stringify({ ...native, revision: 2 }))).toBe(false);
    expect(await isDefault("provider_instances", JSON.stringify({ ...native, id: "work", built_in: false }))).toBe(
      false,
    );

    const scratch = {
      kind: "scratch",
      slug: "system-scratch",
      name: "No project",
      description: "",
      archived_at: null,
      config_deleted: false,
    };

    expect(await isDefault("projects", JSON.stringify(scratch))).toBe(true);
    expect(await isDefault("projects", JSON.stringify({ ...scratch, name: "Renamed" }))).toBe(false);
    expect(await isDefault("projects", JSON.stringify({ ...scratch, kind: "project" }))).toBe(false);

    const field = { hlc: "1.0.n", prev: "", seen: [], value: "", edited: false };

    const item = {
      kind: "instance",
      local_id: "native",
      global_id: "codex:native",
      home_node_id: "",
      identity: "",
      unsupported: "",
      deleted: { hlc: "", prev: "", value: false },
      fields: { label: field },
    };

    expect(await isDefault("config_items", JSON.stringify(item))).toBe(true);
    expect(
      await isDefault("config_items", JSON.stringify({ ...item, fields: { label: { ...field, edited: true } } })),
    ).toBe(false);
    expect(await isDefault("user_settings", "{}")).toBe(false);
  });
});
