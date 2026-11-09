import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable, startPostgres, type TestPostgres } from "@canopy/db/testing";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { saveRecords } from "../../apps/gateway/src/config-sync/record-batches.ts";
import { configLock, emptyRecord, type ConfigRow } from "../../apps/gateway/src/config-sync/persistence.ts";

describe.skipIf(!dockerAvailable)("durable configuration record batches", () => {
  let pg: TestPostgres;
  let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>;
  const owner = Bun.randomUUIDv7();
  const other = Bun.randomUUIDv7();
  const node = "a".repeat(64);
  const hlc = `1000.0.${node}`;
  const initial = 9007199254740993n;

  const write = (rows: ConfigRow[], target = owner) =>
    runtime.runPromise(
      SqlClient.SqlClient.use((sql) =>
        sql.withTransaction(Effect.andThen(configLock(sql, target), saveRecords(sql, target, rows, hlc))),
      ),
    );

  const query = <A extends object>(text: string, params: readonly string[] = []) =>
    runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<A>(text, [...params])));

  beforeAll(async () => {
    pg = await startPostgres({ migrated: true });
    runtime = ManagedRuntime.make(pg.layer);
    await query(
      "INSERT INTO users(id,email,role,display_name) VALUES($1::uuid,'batch-owner@example.test','user','Owner'),($2::uuid,'batch-other@example.test','user','Other')",
      [owner, other],
    );
    await query("INSERT INTO config_clock(owner_user_id,revision) VALUES($1::uuid,$2::bigint)", [
      owner,
      initial.toString(),
    ]);
  }, 60_000);

  afterAll(async () => {
    await runtime?.dispose();
    await pg?.stop();
  });

  const rows = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, n) => {
      const row = emptyRecord("instruction", `${prefix}-${n}`, node);
      row.fields = {
        content: {
          value: "Synthetic ".repeat(900),
          hlc,
          prev: "",
          edited: n % 2 === 0,
          seen: [`900.0.${node}`],
        },
      };

      return row;
    });

  test("bounded batches retain exact ordered revisions, owner isolation and state after reopening", async () => {
    const records = rows("durable", 300);
    await write(records);
    await write(rows("foreign", 1), other);
    await runtime.dispose();
    runtime = ManagedRuntime.make(pg.layer);

    const persisted = await query<{ global_id: string; revision: string; fields: ConfigRow["fields"] }>(
      "SELECT global_id,revision::text,fields FROM config_items WHERE owner_user_id=$1::uuid ORDER BY revision",
      [owner],
    );

    expect(persisted.map((row) => row.global_id)).toEqual(records.map((row) => row.global_id));
    expect(persisted.map((row) => row.revision)).toEqual(records.map((_, n) => (initial + BigInt(n) + 1n).toString()));
    expect(persisted.map((row) => row.fields)).toEqual(records.map((row) => row.fields));

    const clock = await query<{ revision: string; hlc: string }>(
      "SELECT revision::text,hlc FROM config_clock WHERE owner_user_id=$1::uuid",
      [owner],
    );

    expect(clock).toEqual([{ revision: (initial + 300n).toString(), hlc }]);
    expect(await query("SELECT global_id FROM config_items WHERE owner_user_id=$1::uuid", [other])).toEqual([
      { global_id: "foreign-0" },
    ]);
  });

  test("a late batch failure rolls back every earlier row and the allocated revision range", async () => {
    const records = rows("rollback", 300);
    records.at(-1)!.schema_version = 0;
    await expect(write(records)).rejects.toThrow();

    expect(
      await query("SELECT global_id FROM config_items WHERE owner_user_id=$1::uuid AND global_id LIKE 'rollback-%'", [
        owner,
      ]),
    ).toEqual([]);
    expect(await query("SELECT revision::text FROM config_clock WHERE owner_user_id=$1::uuid", [owner])).toEqual([
      { revision: (initial + 300n).toString() },
    ]);
  });

  test("upsert retains the original home while persisting tombstones and unsupported fields", async () => {
    await write([emptyRecord("worker", "home-preserved", node)]);

    const persistedRows = await query<ConfigRow>(
      "SELECT * FROM config_items WHERE owner_user_id=$1::uuid AND global_id='home-preserved'",
      [owner],
    );

    const row = persistedRows[0]!;

    row.home_node_id = "b".repeat(64);
    row.deleted = { value: true, hlc, prev: "" };
    row.fields = { newer: { value: { flag: true }, hlc, prev: "" } };
    row.unsupported = "newer schema";
    row.schema_version = 2;
    await write([row]);

    const persisted = await query<
      Pick<ConfigRow, "home_node_id" | "fields" | "deleted" | "unsupported" | "schema_version">
    >(
      "SELECT home_node_id,fields,deleted,unsupported,schema_version FROM config_items WHERE owner_user_id=$1::uuid AND global_id='home-preserved'",
      [owner],
    );

    expect(persisted).toEqual([
      { home_node_id: node, fields: row.fields, deleted: row.deleted, unsupported: row.unsupported, schema_version: 2 },
    ]);
  });
});
