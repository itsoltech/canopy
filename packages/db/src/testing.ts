import type { PgClient, PgPool } from "@effect/sql-pg";
import type { Layer } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgresServer, testAdmin, testDatabase, testDatabasePool } from "./testing-server.ts";

export const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

export interface TestPostgres {
  readonly layer: Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, SqlError.SqlError>;
  readonly poolLayer: Layer.Layer<PgPool.PgPool, SqlError.SqlError>;
  readonly stop: () => Promise<void>;
}

/** Isolated PostgreSQL 17 database. Migration tests get an empty database; other fixtures can clone the schema. */
export async function startPostgres(options: { migrated?: boolean } = {}): Promise<TestPostgres> {
  const descriptor = join(tmpdir(), ".canopy-test-postgres-port");
  const sharedPort = existsSync(descriptor) ? readFileSync(descriptor, "utf8").trim() : undefined;
  const owned = sharedPort ? undefined : await startTestPostgresServer();
  const port = Number(sharedPort ?? owned?.port);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("Invalid test PostgreSQL port");

  const admin = testAdmin(port);
  // Generated identifiers contain only letters, numbers and underscores; no caller input is interpolated.
  const database = `canopy_${Bun.randomUUIDv7().replaceAll("-", "")}`;

  try {
    await admin.unsafe(`CREATE DATABASE ${database} TEMPLATE ${options.migrated ? "canopy_template" : "template0"}`);
  } catch (error) {
    await admin.close();
    await owned?.stop();
    throw error;
  }

  return {
    layer: testDatabase(port, database),
    poolLayer: testDatabasePool(port, database),
    stop: async () => {
      try {
        await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
      } finally {
        await admin.close();
        await owned?.stop();
      }
    },
  };
}
