import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PgClient } from "@effect/sql-pg";
import { dockerAvailable, startPostgres, type TestPostgres } from "@canopy/db/testing";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { inspectStorage } from "../src/maintenance/storage-inspection.ts";
import { reclaimStorage } from "../src/maintenance/reclaim.ts";
import { storageCli } from "../src/storage-cli.ts";

let pg: TestPostgres;
let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient | PgClient.PgClient, unknown>;

interface OperatorEnvironment {
  readonly CANOPY_DATABASE_URL: string;
}

let environment: OperatorEnvironment;

const sqlRun = <A>(effect: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
  runtime.runPromise(SqlClient.SqlClient.use(effect));

async function command(...args: string[]) {
  const child = Bun.spawn([process.execPath, "apps/gateway/src/main.ts", "storage", ...args], {
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { out, error, code };
}

describe.skipIf(!dockerAvailable)("gateway storage operator maintenance", () => {
  beforeAll(async () => {
    pg = await startPostgres();
    runtime = ManagedRuntime.make(pg.layer);

    const endpoint = await runtime.runPromise(PgClient.PgClient.use((sql) => Effect.succeed(sql.config)));

    environment = {
      CANOPY_DATABASE_URL: `postgres://postgres:test@${endpoint.host}:${endpoint.port}/${endpoint.database}`,
    };
    await sqlRun(
      (sql) => sql`CREATE TABLE public.thread_events (id integer PRIMARY KEY, payload text NOT NULL)
      WITH (autovacuum_enabled=false, toast.autovacuum_enabled=false)`,
    );
    await sqlRun(
      (sql) => sql`INSERT INTO public.thread_events
      SELECT n, (SELECT string_agg(md5(n::text || ':' || m::text),'') FROM generate_series(1,160) m)
      FROM generate_series(1,512) n`,
    );
    await sqlRun((sql) => sql`DELETE FROM public.thread_events WHERE id>1`);
    await sqlRun((sql) => sql`ANALYZE public.thread_events`);
  }, 60_000);

  afterAll(async () => {
    await runtime?.dispose();
    await pg?.stop();
  });

  test("reports heap, TOAST and indexes without reading contents or applying migrations", async () => {
    const report = await sqlRun(inspectStorage);
    const relation = report.relations.find((row) => row.table === "thread_events");

    expect(report.relations).toHaveLength(1);
    expect(relation).toMatchObject({ schema: "public", table: "thread_events", reclaimable: true });
    expect(BigInt(relation!.heapBytes)).toBeGreaterThan(0n);
    expect(BigInt(relation!.toastBytes)).toBeGreaterThan(1_000_000n);
    expect(BigInt(relation!.indexBytes)).toBeGreaterThan(0n);
    expect(BigInt(relation!.totalBytes)).toBeGreaterThan(BigInt(relation!.toastBytes));
    expect(relation?.liveTuplesEstimate).toBe("1");
    expect(BigInt(relation!.deadTuplesEstimate)).toBeGreaterThanOrEqual(0n);

    const cli = await command("inspect");

    expect(cli.code).toBe(0);
    expect(cli.error).toBe("");
    expect(cli.out).toContain('"totalBytes":');
    expect(cli.out).not.toContain("payload");
    expect(cli.out).not.toContain("postgres://");
    expect(await sqlRun((sql) => sql`SELECT to_regclass('public.users') AS migrated`)).toEqual([{ migrated: null }]);
  });

  test("requires explicit offline selection, rejects arbitrary identifiers and transactions", async () => {
    const errors: string[] = [];
    const output = { out: () => {}, error: (line: string) => errors.push(line) };

    expect(await storageCli(["reclaim", "--table", "thread_events"], {}, output)).toBe(64);
    expect(await storageCli(["reclaim", "--offline"], {}, output)).toBe(64);
    expect(await storageCli(["reclaim", "--offline", "--table", "pg_class"], {}, output)).toBe(64);
    expect(
      await storageCli(["reclaim", "--offline", "--table", 'thread_events";DROP TABLE thread_events;--'], {}, output),
    ).toBe(64);
    expect(errors.join(" ")).not.toContain("CANOPY_DATABASE_URL");
    await expect(sqlRun((sql) => reclaimStorage(sql, false, ["thread_events"]))).rejects.toThrow("requires --offline");
    await expect(sqlRun((sql) => reclaimStorage(sql, true, ["pg_class"]))).rejects.toThrow(
      "outside the reclaim allowlist",
    );
    await expect(sqlRun((sql) => sql.withTransaction(reclaimStorage(sql, true, ["thread_events"])))).rejects.toThrow(
      "outside a transaction",
    );
  });

  test("refuses other idle clients without terminating them or rewriting tables", async () => {
    const before = await sqlRun((sql) => sql`SELECT pg_relation_filenode('public.thread_events') AS file`);
    const other = ManagedRuntime.make(pg.layer);

    try {
      const pid = await other.runPromise(SqlClient.SqlClient.use((sql) => sql`SELECT pg_backend_pid() AS pid`));
      const cli = await command("reclaim", "--offline", "--table", "thread_events");

      expect(cli.code).toBe(1);
      expect(cli.error).toContain("Other database sessions");
      await expect(sqlRun((sql) => reclaimStorage(sql, true, ["thread_events"]))).rejects.toThrow(
        "Other database sessions",
      );
      expect(await other.runPromise(SqlClient.SqlClient.use((sql) => sql`SELECT pg_backend_pid() AS pid`))).toEqual(
        pid,
      );
      expect(await sqlRun((sql) => sql`SELECT pg_relation_filenode('public.thread_events') AS file`)).toEqual(before);
    } finally {
      await other.dispose();
    }
  });

  test("preflights all selections before the first rewrite", async () => {
    const before = await sqlRun((sql) => sql`SELECT pg_relation_filenode('public.thread_events') AS file`);

    await expect(sqlRun((sql) => reclaimStorage(sql, true, ["thread_events", "thread_items"]))).rejects.toThrow(
      "missing ordinary table",
    );
    expect(await sqlRun((sql) => sql`SELECT pg_relation_filenode('public.thread_events') AS file`)).toEqual(before);
  });

  test("one-shot CLI physically reclaims only selected relations and preserves live rows", async () => {
    await sqlRun((sql) => sql`CREATE TABLE public.blobs AS SELECT * FROM public.thread_events`);
    const retained = await sqlRun((sql) => sql`SELECT id, md5(payload) AS hash FROM public.thread_events`);
    const untouched = await sqlRun((sql) => sql`SELECT pg_relation_filenode('public.blobs') AS file`);
    const before = await sqlRun(inspectStorage);

    await runtime.dispose();

    try {
      const cli = await command("reclaim", "--offline", "--table", "thread_events", "--table", "thread_events");

      expect(cli.code).toBe(0);
      expect(cli.error).toBe("");
      expect(cli.out).toBe(JSON.stringify({ reclaimed: ["thread_events"] }, null, 2) + "\n");
    } finally {
      runtime = ManagedRuntime.make(pg.layer);
    }

    const after = await sqlRun(inspectStorage);
    const beforeBytes = BigInt(before.relations.find((row) => row.table === "thread_events")!.totalBytes);
    const afterBytes = BigInt(after.relations.find((row) => row.table === "thread_events")!.totalBytes);

    expect(afterBytes).toBeLessThan(beforeBytes / 10n);
    expect(await sqlRun((sql) => sql`SELECT id, md5(payload) AS hash FROM public.thread_events`)).toEqual(retained);
    expect(await sqlRun((sql) => sql`SELECT pg_relation_filenode('public.blobs') AS file`)).toEqual(untouched);
    expect(await sqlRun((sql) => sql`SELECT to_regclass('public.users') AS migrated`)).toEqual([{ migrated: null }]);
  }, 15_000);
});
