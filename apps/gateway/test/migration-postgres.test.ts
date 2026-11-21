import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable, startPostgres, type TestPostgres } from "@canopy/db/testing";
import { PgClient } from "@effect/sql-pg";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import {
  dumpDatabase,
  inspectDatabase,
  inspectDatabaseCapacity,
  inspectTrialSample,
  preflightDatabase,
  readRestoreReceipt,
  restoreDatabase,
  withTrialDatabase,
} from "../src/migration/postgres.ts";

const toolsAvailable = ["psql", "pg_dump", "pg_restore"].every((tool) => {
  if (!Bun.which(tool)) return false;

  const result = Bun.spawnSync([tool, "--version"], { stderr: "ignore" });
  const major = /\(PostgreSQL\) (\d+)/.exec(result.stdout.toString())?.[1];

  return result.success && Number(major) >= 17;
});

const runtime = (pg: TestPostgres) => ManagedRuntime.make(pg.layer);

async function connection(db: ReturnType<typeof runtime>, passwordFile: string): Promise<NodeJS.ProcessEnv> {
  const endpoint = await db.runPromise(PgClient.PgClient.use((sql) => Effect.succeed(sql.config)));

  return {
    CANOPY_DATABASE_URL: `postgres://postgres@${endpoint.host}:${endpoint.port}/${endpoint.database}?sslmode=disable&require_auth=scram-sha-256`,
    CANOPY_DATABASE_PASSWORD_FILE: passwordFile,
  };
}

describe.skipIf(!dockerAvailable || !toolsAvailable)("gateway PostgreSQL snapshots", () => {
  test("refuses unsafe targets and rolls back incomplete archives before a successful retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "canopy-move-test-"));
    let source: TestPostgres | undefined;
    let target: TestPostgres | undefined;
    let sourceDb: ReturnType<typeof runtime> | undefined;
    let targetDb: ReturnType<typeof runtime> | undefined;

    try {
      source = await startPostgres({ migrated: true });
      target = await startPostgres();
      sourceDb = runtime(source);
      targetDb = runtime(target);
      const passwordFile = join(directory, "password");
      await writeFile(passwordFile, "test\n", { mode: 0o600 });

      const from = await connection(sourceDb, passwordFile);
      const to = await connection(targetDb, passwordFile);
      const archive = join(directory, "complete.dump");
      const partial = join(directory, "incomplete.dump");
      const runId = crypto.randomUUID();

      await sourceDb.runPromise(
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO public.users (id, email, display_name, role)
            VALUES (${Bun.randomUUIDv7()}::uuid, 'dev@localhost', 'Moved owner', 'admin')`;
            yield* sql`INSERT INTO public.gateway_relocation_fence(operation_id, state)
              VALUES (${runId}::uuid, 'drained')`;
            yield* sql`CREATE TABLE public.zz_migration_payload (id integer PRIMARY KEY, payload text NOT NULL)`;
            yield* sql`INSERT INTO public.zz_migration_payload
            SELECT n, md5(n::text) || md5((-n)::text) FROM generate_series(1, 6000) n`;
          }),
        ),
      );
      await sourceDb.dispose();
      const snapshot = await inspectDatabase(from);

      expect(snapshot).toMatchObject({ postgresMajor: 17, nodeId: null, certificateSha256: null });
      expect(snapshot.schemaMigration).toBeGreaterThan(0);
      await dumpDatabase(from, archive);
      await copyFile(archive, partial);
      // Remove part of the payload while keeping the archive's table of contents readable.
      await truncate(partial, (await stat(partial)).size - 16_384);

      await targetDb.dispose();
      expect(await readRestoreReceipt(to, runId)).toBeUndefined();
      expect(await preflightDatabase(to, await inspectDatabaseCapacity(from))).toMatchObject({ postgresMajor: 17 });

      const trial = await withTrialDatabase(to, runId, async (trialEnv) => {
        const invalid = { runId: crypto.randomUUID(), archiveSha256: "a".repeat(64) };
        await expect(restoreDatabase(trialEnv, archive, snapshot, invalid)).rejects.toThrow("matching drained");
        expect((await inspectDatabase(trialEnv)).schemaMigration).toBe(0);
        await restoreDatabase(trialEnv, archive, snapshot);
        expect(await inspectTrialSample(trialEnv)).toEqual({ threads: 0, workers: 0, devices: 0, attachments: 0 });

        return trialEnv;
      });

      await expect(inspectDatabaseCapacity(trial)).rejects.toThrow("Could not inspect");
      await expect(restoreDatabase(to, archive, { ...snapshot, postgresMajor: 18 })).rejects.toThrow(
        "lower than the source",
      );

      targetDb = runtime(target);
      await targetDb.runPromise(SqlClient.SqlClient.use((sql) => sql`CREATE SCHEMA unrelated`));
      await expect(restoreDatabase(to, archive, snapshot)).rejects.toThrow("Other database sessions");

      await targetDb.dispose();
      await expect(restoreDatabase(to, archive, snapshot)).rejects.toThrow("database must be empty");

      targetDb = runtime(target);
      await targetDb.runPromise(SqlClient.SqlClient.use((sql) => sql`DROP SCHEMA unrelated`));
      await targetDb.dispose();

      await expect(restoreDatabase(to, partial, snapshot)).rejects.toThrow("PostgreSQL restore failed");
      expect(await inspectDatabase(to)).toEqual({
        postgresMajor: 17,
        schemaMigration: 0,
        nodeId: null,
        certificateSha256: null,
        encryptedKeySha256: null,
      });

      const wrongOwner = { ...to, CANOPY_DEV_USER_EMAIL: "unrelated@localhost" };
      await expect(restoreDatabase(wrongOwner, archive, snapshot)).rejects.toThrow("CANOPY_DEV_USER_EMAIL");
      expect((await inspectDatabase(to)).schemaMigration).toBe(0);

      const receipt = { runId, archiveSha256: "b".repeat(64) };
      await restoreDatabase(to, archive, snapshot, receipt);
      expect(await readRestoreReceipt(to, runId)).toEqual(receipt);
      expect(await inspectDatabase(to)).toEqual(snapshot);

      targetDb = runtime(target);

      const users = await targetDb.runPromise(
        SqlClient.SqlClient.use((sql) => sql`SELECT display_name FROM public.users`),
      );

      expect(users).toEqual([{ display_name: "Moved owner" }]);

      const payload = await targetDb.runPromise(
        SqlClient.SqlClient.use((sql) => sql`SELECT count(*)::int AS rows FROM public.zz_migration_payload`),
      );

      expect(payload).toEqual([{ rows: 6000 }]);
    } finally {
      await Promise.allSettled([sourceDb?.dispose(), targetDb?.dispose()]);
      await Promise.all([source?.stop(), target?.stop(), rm(directory, { recursive: true, force: true })]);
    }
  }, 60_000);
});
