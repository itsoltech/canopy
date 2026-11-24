import { expect, test } from "bun:test";
import { SQL } from "bun";
import { PgClient } from "@effect/sql-pg";
import { migrate, migrations } from "@canopy/db";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect, ManagedRuntime, Redacted } from "effect";
import { Migrator } from "effect/sql";
import { startTestPostgresServer, testAdmin } from "../../packages/db/src/testing-server.ts";

test.skipIf(!dockerAvailable)(
  "a non-superuser upgrades worktrees without a PostgreSQL parameter grant",
  async () => {
    const server = await startTestPostgresServer();
    const admin = testAdmin(server.port);
    const url = `postgres://canopy_migrator:test@127.0.0.1:${server.port}/worktree_upgrade`;
    const layer = PgClient.layer({ url: Redacted.make(url) });
    const baseline = ManagedRuntime.make(layer);
    const upgrade = ManagedRuntime.make(layer);
    const db = new SQL(url);

    try {
      await admin.unsafe("CREATE ROLE canopy_migrator LOGIN NOSUPERUSER PASSWORD 'test'");
      await admin.unsafe("CREATE DATABASE worktree_upgrade OWNER canopy_migrator");
      await baseline.runPromise(
        Migrator.make({})({
          loader: Effect.map(migrations, (all) => all.filter(([id]) => id <= 209)),
          table: "schema_migrations",
        }),
      );
      await baseline.dispose();

      expect(
        await db`SELECT rolsuper,
          has_parameter_privilege(current_user, 'canopy.switch_worktree_turn', 'SET') AS parameter_grant
          FROM pg_roles WHERE rolname=current_user`,
      ).toEqual([{ rolsuper: false, parameter_grant: false }]);
      const applied = await upgrade.runPromise(migrate);
      expect(applied).toContainEqual([213, "thread_worktree_switch"]);
      expect(await upgrade.runPromise(migrate)).toEqual([]);

      const owner = Bun.randomUUIDv7();
      const worker = Bun.randomUUIDv7();
      const project = Bun.randomUUIDv7();
      const workspace = Bun.randomUUIDv7();
      const thread = Bun.randomUUIDv7();
      const turn = Bun.randomUUIDv7();
      const tree = Bun.randomUUIDv7();
      const previousMarker = Bun.randomUUIDv7();

      await db.begin(async (tx) => {
        await tx`INSERT INTO users(id,email,display_name,role) VALUES (${owner},'worktree@example.test','Owner','user')`;
        await tx`INSERT INTO workers(id,owner_user_id,name,credential_hash) VALUES (${worker},${owner},'Worker','hash')`;
        await tx`INSERT INTO projects(id,owner_user_id,name,slug) VALUES (${project},${owner},'Project','worktree')`;
        await tx`INSERT INTO project_workspaces(id,project_id,worker_id,root_path)
          VALUES (${workspace},${project},${worker},'/repo')`;
        await tx`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,worker_id,workspace_id,cwd)
          VALUES (${thread},${project},${owner},'main',${thread},'worker','codex',${worker},${workspace},'/repo')`;
        await tx`INSERT INTO turns(id,thread_id,ordinal,status,trigger,input,started_at)
          VALUES (${turn},${thread},1,'running','provider','{}',now())`;
        await tx`INSERT INTO worktrees(id,owner_user_id,project_id,workspace_id,worker_id,repo_root,path,branch)
          VALUES (${tree},${owner},${project},${workspace},${worker},'/repo','/trees/feature','feature')`;
        await tx`SELECT set_config('canopy.switch_worktree_turn', ${previousMarker}, true)`;
        expect(
          await tx`SELECT cwd,worktree_id FROM switch_thread_worktree(
            ${owner},${worker},${thread},${turn},'/repo',NULL,${tree},'/repo')`,
        ).toEqual([{ cwd: "/trees/feature", worktree_id: tree }]);
        expect(await tx`SELECT current_setting('canopy.switch_worktree_turn') AS marker`).toEqual([
          { marker: previousMarker },
        ]);
      });
    } finally {
      await db.close();
      await upgrade.dispose();
      await baseline.dispose();
      await admin.close();
      await server.stop();
    }
  },
  90_000,
);
