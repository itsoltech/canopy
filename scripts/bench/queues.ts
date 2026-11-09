import { create, toBinary } from "@bufbuild/protobuf";
import { CommandSchema } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore, AgentBusStore } from "../../apps/gateway/src/store/index.ts";
import { runs } from "../../apps/gateway/src/imports/store.ts";
import { ids } from "./seed.ts";
import type { Operation } from "./operations.ts";

/** Large queues and completed imports, independent of the latency sample count. */
export const seedQueues = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const payload = toBinary(
    CommandSchema,
    create(CommandSchema, {
      kind: { case: "unloadThread", value: { threadId: ids.thread } },
    }),
  );

  yield* sql`INSERT INTO worker_commands(id,worker_id,thread_id,kind,payload,expires_at,created_at)
    SELECT md5('queued-command-'||n)::uuid,${ids.worker}::uuid,${ids.thread}::uuid,'unloadThread',
      ${payload},now()+interval '1 day',now()-(n||' milliseconds')::interval
    FROM generate_series(1,4096) n`;
  yield* sql`INSERT INTO worker_commands(id,worker_id,kind,payload,status,expires_at,completed_at)
    SELECT md5('done-command-'||n)::uuid,${ids.worker}::uuid,'unloadThread',${payload},'completed',
      now()-interval '8 days',now()-interval '8 days' FROM generate_series(1,16384) n`;
  yield* sql`INSERT INTO import_runs(id,owner_user_id,worker_id,status,mode,finished_at)
    SELECT md5('large-import-'||n)::uuid,${ids.owner}::uuid,${ids.worker}::uuid,'completed','history',now()
    FROM generate_series(1,50) n`;

  // One run per statement bounds deferred trigger memory during fixture construction.
  for (let run = 1; run <= 50; run++) {
    yield* sql`INSERT INTO import_items(id,run_id,owner_user_id,worker_id,position,agent_cli,root_id,
      native_id,source_key,title,cwd,snapshot,target,status,bytes_total,bytes_done)
      SELECT md5('large-import-item-'||${run}||'-'||n)::uuid,md5('large-import-'||${run})::uuid,
        ${ids.owner}::uuid,${ids.worker}::uuid,n,'codex','synthetic',${run}||'-'||n,${run}||'-'||n,
        'Synthetic imported thread '||n,'/benchmark','{"size":"100000","modifiedMs":"0","prefixSha256":""}',
        '{"projectId":"","workspaceId":"","cwd":"/benchmark","mode":"history"}',
        CASE WHEN n%10=0 THEN 'failed' ELSE 'done' END,100000,50000 FROM generate_series(1,2000) n`;
  }

  yield* sql`ANALYZE`;
});

export const queueOperations = (): Operation[] => [
  {
    name: "imports/progress",
    run: async (runtime) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runs(sql, ids.owner);
        }),
      );
    },
  },
  {
    name: "commands/pending",
    run: async (runtime) => {
      await runtime.runPromise(GatewayStore.use((store) => store.pendingCommands(ids.worker)));
    },
  },
  {
    name: "worktrees/branch-context",
    run: async (runtime) => {
      await runtime.runPromise(GatewayStore.use((store) => store.branchContext(ids.thread)));
    },
  },
  {
    name: "schedules/claim-empty",
    run: async (runtime) => {
      await runtime.runPromise(AgentBusStore.use((store) => store.claimDueSchedules("benchmark", new Date(), 60)));
    },
  },
];
