import { expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrations, migrate } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";

test.skipIf(!dockerAvailable)(
  "upgrade hides consumed bus inputs but preserves dispatched and genuine cancellations",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);

    try {
      await runtime.runPromise(
        Migrator.make({})({
          loader: migrations.pipe(Effect.map((all) => all.filter(([id]) => id < 96))),
          table: "schema_migrations",
        }),
      );
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const user = Bun.randomUUIDv7();
          const worker = Bun.randomUUIDv7();
          const project = Bun.randomUUIDv7();
          const workspace = Bun.randomUUIDv7();
          const thread = Bun.randomUUIDv7();
          yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${user}::uuid,'consumed@test.local','Owner','user')`;
          yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash) VALUES(${worker}::uuid,${user}::uuid,'Worker','hash')`;
          yield* sql`INSERT INTO projects(id,owner_user_id,name,slug) VALUES(${project}::uuid,${user}::uuid,'Project','consumed')`;
          yield* sql`INSERT INTO project_workspaces(id,project_id,worker_id,root_path) VALUES(${workspace}::uuid,${project}::uuid,${worker}::uuid,'/repo')`;
          yield* sql`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,worker_id,workspace_id,cwd,status)
        VALUES(${thread}::uuid,${project}::uuid,${user}::uuid,'main',${thread}::uuid,'worker','codex',${worker}::uuid,${workspace}::uuid,'/repo','idle')`;

          for (const [index, kind] of ["message", "report", "started", "dispatched", "cancelled"].entries()) {
            const turn = Bun.randomUUIDv7();
            const call = Bun.randomUUIDv7();
            yield* sql`INSERT INTO agent_bus_calls(id,source_thread_id,tool,arguments,status,hops,completed_at)
          VALUES(${call}::uuid,${thread}::uuid,'send_message','{}','completed',1,now())`;
            yield* sql`INSERT INTO turns(id,thread_id,ordinal,status,trigger,agent_call_id,hops,input,started_at,completed_at)
          VALUES(${turn}::uuid,${thread}::uuid,${index + 1},'cancelled','agent_bus',${call}::uuid,1,'{}',
            CASE WHEN ${kind === "started"} THEN now() END,now())`;

            if (kind === "report")
              yield* sql`UPDATE agent_bus_calls SET notify=true,notify_status='consumed_by_read',notified_turn_id=${turn}::uuid WHERE id=${call}::uuid`;
            else if (kind !== "cancelled")
              yield* sql`UPDATE agent_bus_calls SET target_thread_id=${thread}::uuid,target_turn_id=${turn}::uuid,message_consumed='consumed_by_wait' WHERE id=${call}::uuid`;

            if (kind === "dispatched")
              yield* sql`INSERT INTO worker_commands(id,worker_id,thread_id,turn_id,kind,payload,status,expires_at)
            VALUES(${Bun.randomUUIDv7()}::uuid,${worker}::uuid,${thread}::uuid,${turn}::uuid,'startTurn',''::bytea,'completed',now())`;
          }
        }),
      );
      expect(await runtime.runPromise(migrate)).toContainEqual([96, "consumed_bus_turns"]);

      const rows = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql<{ withdrawn: string | null }>`SELECT withdrawn FROM turns ORDER BY ordinal`;
        }),
      );

      expect(rows.map((row) => row.withdrawn)).toEqual(["consumed", "consumed", null, null, null]);
      expect(await runtime.runPromise(migrate)).toEqual([]);
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60000,
);
