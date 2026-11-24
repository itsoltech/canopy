import { expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrate, migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";

test.skipIf(!dockerAvailable)(
  "Antigravity enrollment preserves existing worker login policies and configuration history",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);
    const owner = crypto.randomUUID();

    const cases = [
      { name: "device", providers: { codex: { enabled: true } }, expected: { enabled: true } },
      {
        name: "keys",
        providers: { codex: { enabled: true, deviceLogin: "DEVICE_LOGIN_NONE" }, claude: { enabled: false } },
        expected: { enabled: true, deviceLogin: "DEVICE_LOGIN_NONE" },
      },
      { name: "disabled", providers: { grok: { enabled: false } }, expected: { enabled: false } },
    ];

    try {
      await runtime.runPromise(
        Migrator.make({})({
          loader: migrations.pipe(Effect.map((all) => all.filter(([id]) => id < 215))),
          table: "schema_migrations",
        }),
      );
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${owner}::uuid,'test@example.test','Owner','user')`;

          for (const fixture of cases) {
            const worker = crypto.randomUUID();
            yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash) VALUES(${worker}::uuid,${owner}::uuid,${fixture.name},${worker})`;
            const config = { version: "7", allowedRoots: ["/projects"], ...fixture.providers };
            yield* sql`INSERT INTO worker_configs(worker_id,version,config,updated_by) VALUES(${worker}::uuid,7,${JSON.stringify(config)}::jsonb,${owner}::uuid)`;
          }
        }),
      );
      expect(await runtime.runPromise(migrate)).toContainEqual([215, "antigravity_provider"]);
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          for (const fixture of cases) {
            const history = yield* sql<{
              version: number;
              config: object;
            }>`SELECT h.version::int, h.config FROM worker_config_history h
          JOIN workers w ON w.id=h.worker_id WHERE w.name=${fixture.name} ORDER BY h.version`;

            const original = { allowedRoots: ["/projects"], ...fixture.providers };
            expect(history).toEqual([
              { version: 7, config: { version: "7", ...original } },
              { version: 8, config: { version: "8", ...original, antigravity: fixture.expected } },
            ]);
          }

          expect(
            yield* sql`SELECT id, kind, built_in, all_workers FROM provider_instances WHERE harness='antigravity'`,
          ).toEqual([{ id: "native", kind: "native", built_in: true, all_workers: true }]);
        }),
      );
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
