import { create, toBinary } from "@bufbuild/protobuf";
import { CommandSchema } from "@canopy/contracts";
import { migrate } from "@canopy/db";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore } from "../../apps/gateway/src/store/index.ts";
import { database } from "./database.ts";
import { runtime } from "./runtime.ts";
import { ids, seed } from "./seed.ts";
import { PlanCapture } from "./plan-capture.ts";
import { Recorder } from "./trace.ts";
import type { Operation } from "./operations.ts";

if (!process.argv.includes("--run")) throw new Error("Opt in with --run; only a new private database is used");

const active = process.argv.includes("--large-active-queue") ? 4096 : 64;
const tree = "50000000-0000-4000-8000-000000000001";
const treeThread = "30000000-0000-4000-8000-000000000002";
const owned = await database();
const normal = runtime(owned.url);
const recorder = new Recorder();
const diagnostic = runtime(owned.url, recorder);

const fixtures = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO worktrees(id,owner_user_id,project_id,workspace_id,worker_id,repo_root,path,branch,last_used_at)
    SELECT ${tree}::uuid,owner_user_id,project_id,workspace_id,worker_id,cwd,'/benchmark/tree','synthetic',now()-interval '1 year'
    FROM threads WHERE id=${ids.thread}::uuid`;
  yield* sql`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,
    worker_id,workspace_id,cwd,status,title,worktree_id)
    SELECT ${treeThread}::uuid,project_id,owner_user_id,'main',${treeThread}::uuid,'worker','codex',
    worker_id,workspace_id,'/benchmark/tree','idle','Synthetic worktree thread',${tree}::uuid
    FROM threads WHERE id=${ids.thread}::uuid`;
  yield* sql`INSERT INTO turns(id,thread_id,ordinal,status,trigger,author_user_id,input,first_seq,last_seq,queued_at,started_at,completed_at)
    SELECT md5('tree-turn-'||n)::uuid,${treeThread}::uuid,n,'completed','user',${ids.owner}::uuid,'{}',n,n,
    now()-(n||' minutes')::interval,CASE WHEN n%2=0 THEN NULL ELSE now()-(n||' minutes')::interval END,
    CASE WHEN n%3=0 THEN NULL ELSE now()-(n||' seconds')::interval END FROM generate_series(1,8192)n`;

  const payload = toBinary(
    CommandSchema,
    create(CommandSchema, {
      kind: { case: "unloadThread", value: { threadId: ids.thread } },
    }),
  );

  yield* sql`INSERT INTO worker_commands(id,worker_id,thread_id,kind,payload,expires_at,created_at)
    SELECT md5('expired-prefix-'||n)::uuid,${ids.worker}::uuid,${ids.thread}::uuid,'unloadThread',${payload},
      now()-interval '1 day',now()-interval '2 days' FROM generate_series(1,32768)n`;
  yield* sql`INSERT INTO worker_commands(id,worker_id,thread_id,kind,payload,expires_at,created_at)
    SELECT md5('live-suffix-'||n)::uuid,${ids.worker}::uuid,${ids.thread}::uuid,'unloadThread',${payload},
      now()+interval '1 day',now() FROM generate_series(1,${active})n`;
  yield* sql`INSERT INTO thread_secrets(id,thread_id,turn_id,call_id,label,description,status,ciphertext,key_id,expires_at,revision)
    SELECT md5('metadata-secret-'||n)::uuid,${treeThread}::uuid,md5('tree-turn-1')::uuid,md5('metadata-call-'||n)::uuid,
      'Synthetic','Synthetic','saved',decode(repeat('ab',8192),'hex'),'synthetic',now()+interval '1 day',1
      FROM generate_series(1,64)n`;
  yield* sql`ANALYZE`;
});

const operations: Operation[] = [
  {
    name: "worktrees/inventory-long-history",
    run: async (r) => {
      await r.runPromise(GatewayStore.use((s) => s.worktreeInventory(ids.owner)));
    },
  },
  {
    name: "commands/expired-prefix",
    run: async (r) => {
      await r.runPromise(GatewayStore.use((s) => s.pendingCommands(ids.worker)));
    },
  },
  {
    name: "secrets/metadata",
    run: async (r) => {
      await r.runPromise(GatewayStore.use((s) => s.threadSecrets(ids.owner, treeThread)));
    },
  },
];

try {
  await normal.runPromise(migrate);
  await normal.runPromise(seed({ threads: 8, turns: 8, longTurns: 32, textBytes: 256 }));
  await normal.runPromise(fixtures);
  const results: object[] = [];

  for (const operation of operations) {
    const times: number[] = [];

    for (let i = 0; i < 22; i++) {
      const start = performance.now();
      await operation.run(normal);

      if (i >= 2) times.push(performance.now() - start);
    }

    recorder.samples = [];
    recorder.planCapture = new PlanCapture();
    await operation.run(diagnostic);
    const samples = recorder.samples;
    recorder.samples = undefined;
    results.push({
      operation: operation.name,
      p95Ms: times.toSorted((a, b) => a - b)[18],
      queries: samples.length,
      rows: samples.reduce((n, s) => n + s.rows, 0),
      decodedJsonBytes: samples.reduce((n, s) => n + s.bytes, 0),
      plans: recorder.planCapture.plans,
    });
  }

  console.log(
    JSON.stringify(
      {
        iterations: 20,
        warmups: 2,
        activeCommands: active,
        results,
        method:
          "Private PostgreSQL18;8192 worktree turns;32768 expired commands before active suffix;64 secret ciphertexts of8192 bytes. Serial latency without tracing; separate rolled-back EXPLAIN ANALYZE. JSON bytes are decoded representation, not transport.",
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await diagnostic.dispose();
    await normal.dispose();
  } finally {
    await owned.stop();
  }
}
