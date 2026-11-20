import { expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable } from "@canopy/db/testing";
import { startTestPostgresServer, testAdmin } from "../../packages/db/src/testing-server.ts";
import { migrateCli } from "../../apps/gateway/src/migrate-cli.ts";
import { databaseUrl } from "../../apps/gateway/src/database-credentials.ts";

test.skipIf(!dockerAvailable)(
  "the deploy migrator upgrades an existing database and reuses a DML-only runtime login",
  async () => {
    // The login is a cluster-wide object. This fixture owns its cluster.
    const server = await startTestPostgresServer();
    const admin = testAdmin(server.port);
    const directory = mkdtempSync(join(tmpdir(), "canopy-runtime-role-"));
    const file = join(directory, "runtime-password");
    const address = `127.0.0.1:${server.port}/canopy`;

    const env = {
      CANOPY_DATABASE_URL: `postgres://postgres:test@${address}`,
      CANOPY_DATABASE_RUNTIME_PASSWORD_FILE: file,
    };

    try {
      await admin.unsafe("CREATE DATABASE canopy TEMPLATE canopy_template");
      expect(await migrateCli([], env)).toBe(0);
      const password = readFileSync(file);

      const url = databaseUrl({
        CANOPY_DATABASE_URL: `postgres://canopy_runtime@${address}`,
        CANOPY_DATABASE_PASSWORD_FILE: file,
      });

      const db = new SQL(url, { max: 1 });

      try {
        const id = Bun.randomUUIDv7();
        await db`INSERT INTO users(id,email,display_name,role) VALUES(${id}::uuid,'role@example.test','Runtime','user')`;
        await db`UPDATE users SET display_name='Updated' WHERE id=${id}::uuid`;
        expect(await db`SELECT display_name FROM users WHERE id=${id}::uuid`).toEqual([{ display_name: "Updated" }]);
        expect(
          await db`SELECT current_user AS name,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls
        FROM pg_roles WHERE rolname=current_user`,
        ).toEqual([
          {
            name: "canopy_runtime",
            rolsuper: false,
            rolcreaterole: false,
            rolcreatedb: false,
            rolreplication: false,
            rolbypassrls: false,
          },
        ]);
        expect(
          await db`SELECT has_schema_privilege('public','CREATE') AS ddl,
        has_table_privilege('schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE') AS migration_write`,
        ).toEqual([{ ddl: false, migration_write: false }]);
        await db`DELETE FROM users WHERE id=${id}::uuid`;
      } finally {
        await db.close();
      }

      expect(await migrateCli([], env)).toBe(0);
      // A mismatch should not print either password in the failure message.
      expect(readFileSync(file).equals(password)).toBe(true);
      const reconnect = new SQL(url, { max: 1 });

      try {
        expect((await reconnect`SELECT current_user AS name`)[0].name).toBe("canopy_runtime");
      } finally {
        await reconnect.close();
      }
    } finally {
      await admin.close();
      await server.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
