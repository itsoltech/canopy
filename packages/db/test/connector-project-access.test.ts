import { expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrate, migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";

test.skipIf(!dockerAvailable)(
  "connector project access migrates full placement coverage and keeps bot access",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);
    const owner = Bun.randomUUIDv7();
    const worker = Bun.randomUUIDv7();
    const otherWorker = Bun.randomUUIDv7();
    const covered = Bun.randomUUIDv7();
    const partial = Bun.randomUUIDv7();
    const scratch = Bun.randomUUIDv7();
    const account = Bun.randomUUIDv7();
    const globalAccount = Bun.randomUUIDv7();
    const bot = Bun.randomUUIDv7();

    try {
      await runtime.runPromise(
        Migrator.make({})({
          loader: Effect.map(migrations, (all) => all.filter(([id]) => id < 197)),
          table: "schema_migrations",
        }),
      );
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO users(id,email,display_name,role)
              VALUES (${owner}::uuid,'project-access@example.test','Owner','user')`;
            yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash) VALUES
              (${worker}::uuid,${owner}::uuid,'First worker','first'),
              (${otherWorker}::uuid,${owner}::uuid,'Second worker','second')`;
            yield* sql`INSERT INTO projects(id,owner_user_id,name,slug,kind) VALUES
              (${covered}::uuid,${owner}::uuid,'Covered','covered','project'),
              (${partial}::uuid,${owner}::uuid,'Partial','partial','project'),
              (${scratch}::uuid,${owner}::uuid,'No project','system-scratch','scratch')`;
            yield* sql`INSERT INTO project_workspaces(id,project_id,worker_id,root_path) VALUES
              (gen_random_uuid(),${covered}::uuid,${worker}::uuid,'/covered'),
              (gen_random_uuid(),${partial}::uuid,${worker}::uuid,'/partial'),
              (gen_random_uuid(),${partial}::uuid,${otherWorker}::uuid,'/partial'),
              (gen_random_uuid(),${scratch}::uuid,${worker}::uuid,'/scratch')`;
            yield* sql`INSERT INTO connector_accounts(
              id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,status,all_workers
            ) VALUES
              (${account}::uuid,${owner}::uuid,'custom','Selected','selected','https://example.test','http','headers','connected',false),
              (${globalAccount}::uuid,${owner}::uuid,'github','All','all','https://api.githubcopilot.com/mcp/','http','headers','connected',true)`;
            yield* sql`INSERT INTO github_accounts(
              id,owner_user_id,github_user_id,login,auth_kind,connector_account_id,connector_revision,status
            ) VALUES
              (gen_random_uuid(),${owner}::uuid,'1','current','pat',${globalAccount}::uuid,1,'connected'),
              (gen_random_uuid(),${owner}::uuid,'2','stale','pat',${globalAccount}::uuid,0,'needs_reconnect')`;
            yield* sql`INSERT INTO connector_worker_grants(account_id,worker_id)
              VALUES (${account}::uuid,${worker}::uuid)`;
            yield* sql`INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance)
              VALUES (${bot}::uuid,${owner}::uuid,'project-access','{}','codex','native')`;
            yield* sql`INSERT INTO connector_bot_grants(account_id,bot_id) VALUES (${account}::uuid,${bot}::uuid)`;
          }),
        ),
      );
      await runtime.runPromise(migrate);
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            expect(yield* sql`SELECT account_id,project_id FROM connector_project_grants`).toEqual([
              { account_id: account, project_id: covered },
            ]);
            expect(yield* sql`SELECT id FROM connector_accounts WHERE all_projects`).toEqual([{ id: globalAccount }]);
            expect(yield* sql`SELECT id FROM connector_accounts WHERE no_project`).toEqual([]);
            expect(yield* sql`SELECT login,connector_revision::text FROM github_accounts ORDER BY login`).toEqual([
              { login: "current", connector_revision: "2" },
              { login: "stale", connector_revision: "0" },
            ]);
            expect(yield* sql`SELECT account_id,bot_id FROM connector_bot_grants`).toEqual([
              { account_id: account, bot_id: bot },
            ]);
          }),
        ),
      );
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
