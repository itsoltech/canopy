import { expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrate, migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";

test.skipIf(!dockerAvailable)(
  "memory upgrade isolates old callbacks, continuations and their schedules",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);
    const id = () => Bun.randomUUIDv7();
    const owner = id();
    const project = id();
    const worker = id();
    const workspace = id();
    const bot = id();
    const ordinary = id();
    const delegated = id();
    const continuation = id();
    const scheduled = id();
    const schedule = id();
    const ownerTurn = id();
    const callback = id();

    try {
      await runtime.runPromise(
        Migrator.make({})({
          loader: migrations.pipe(Effect.map((entries) => entries.filter(([n]) => n < 194))),
          table: "schema_migrations",
        }),
      );
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${owner}::uuid,'upgrade@example.test','Owner','user')`;
            yield* sql`INSERT INTO projects(id,owner_user_id,name,slug) VALUES(${project}::uuid,${owner}::uuid,'Project','project')`;
            yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash) VALUES(${worker}::uuid,${owner}::uuid,'Worker','fixture')`;
            yield* sql`INSERT INTO project_workspaces(id,project_id,worker_id,root_path) VALUES(${workspace}::uuid,${project}::uuid,${worker}::uuid,'/repo')`;
            yield* sql`INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance)
        VALUES(${bot}::uuid,${owner}::uuid,'bot','{}','codex','native')`;
            yield* sql`INSERT INTO bot_turns(id,bot_id,client_request_id,input,hops) VALUES
        (${ownerTurn}::uuid,${bot}::uuid,'owner','Owner input',0),(${callback}::uuid,${bot}::uuid,'callback','Report',1)`;
            yield* sql`INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,kind,text)
        VALUES(${id()}::uuid,${bot}::uuid,${ownerTurn}::uuid,'input','user',${bot},'message','Use this thread')`;

            for (const thread of [ordinary, delegated, continuation, scheduled]) {
              yield* sql`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,worker_id,workspace_id,cwd,creation_request_id)
          VALUES(${thread}::uuid,${project}::uuid,${owner}::uuid,'main',${thread}::uuid,'worker','codex',${worker}::uuid,${workspace}::uuid,'/repo',
            ${thread === continuation ? "worktree-continuation:" + delegated + ":first" : null})`;
            }

            for (const [turn, thread] of [
              [ownerTurn, ordinary],
              [callback, delegated],
            ] as const) {
              const call = id();
              yield* sql`INSERT INTO bot_tool_calls(id,turn_id,call_key,tool,arguments,status)
          VALUES(${call}::uuid,${turn}::uuid,'delegate','{"source":"platform","name":"send_message"}','{}','completed')`;
              yield* sql`INSERT INTO bot_thread_watches(call_id,bot_id,target_thread_id,hops) VALUES(${call}::uuid,${bot}::uuid,${thread}::uuid,2)`;
            }

            yield* sql`INSERT INTO schedules(id,thread_id,project_id,kind,prompt,run_at,next_run_at,created_by_user_id)
        VALUES(${schedule}::uuid,${scheduled}::uuid,${project}::uuid,'once','Run',now(),now(),${owner}::uuid)`;
            yield* sql`INSERT INTO bot_tool_calls(id,turn_id,call_key,tool,arguments,status,result)
        VALUES(${id()}::uuid,${callback}::uuid,'schedule','{"name":"create_schedule","source":"platform"}','{}','completed',${JSON.stringify({ id: schedule })}::jsonb)`;
          }),
        ),
      );
      await runtime.runPromise(migrate);

      const rows = await runtime.runPromise(
        SqlClient.SqlClient.use(
          (sql) =>
            sql<{
              id: string;
              memory_audience: string;
            }>`SELECT id,memory_audience FROM threads UNION ALL SELECT id,memory_audience FROM schedules`,
        ),
      );

      expect(Object.fromEntries(rows.map((row) => [row.id, row.memory_audience]))).toMatchObject({
        [ordinary]: "",
        [delegated]: "legacy:" + delegated,
        [continuation]: "legacy:" + continuation,
        [scheduled]: "legacy:" + scheduled,
        [schedule]: "legacy:schedule:" + schedule,
      });
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
