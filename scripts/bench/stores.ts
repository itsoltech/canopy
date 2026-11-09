import { migrate } from "@canopy/db";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore, AgentBusStore } from "../../apps/gateway/src/store/index.ts";
import { database } from "./database.ts";
import { runtime } from "./runtime.ts";
import { ids, seed } from "./seed.ts";
import { Recorder } from "./trace.ts";
import { explain } from "./explain.ts";
import type { Operation } from "./operations.ts";

if (!process.argv.includes("--run")) throw new Error("Opt in with --run; only a private database is used");

const baseline = process.argv.includes("--baseline");
const owned = await database();
const normal = runtime(owned.url);
const recorder = new Recorder();
const diagnostic = runtime(owned.url, recorder);
const targets = Array.from({ length: 32 }, (_, n) => (n === 0 ? ids.thread : Bun.MD5.hash(`thread-${n + 1}`, "hex")));

const targetIds = targets.map((id) =>
  id.length === 32
    ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
    : id,
);

const source = { threadId: ids.thread, turnId: "", itemId: "", callId: crypto.randomUUID() };

const operations: Operation[] = [
  {
    name: "bus/facts-32",
    run: async (r) => {
      await r.runPromise(AgentBusStore.use((s) => s.facts({ source, targetIds: targetIds })));
    },
  },
  {
    name: "notifications/due",
    run: async (r) => {
      await r.runPromise(AgentBusStore.use((s) => s.dueNotifications()));
    },
  },
  {
    name: "config/read-24-secrets",
    run: async (r) => {
      await r.runPromise(GatewayStore.use((s) => s.workerConfig(ids.worker)));
    },
  },
  {
    name: "worker/authenticate-miss",
    run: async (r) => {
      await r.runPromise(GatewayStore.use((s) => s.authenticateWorker("synthetic-missing")));
    },
  },
];

if (!baseline)
  operations.push({
    name: "notifications/read-all",
    run: async (r) => {
      let after: string | undefined;

      for (;;) {
        const page = await r.runPromise(AgentBusStore.use((s) => s.dueNotifications(undefined, after)));

        if (!page.length) break;
        const next = page.at(-1)!.call.id;

        if (next === after) throw new Error("Notification cursor did not advance");
        after = next;
      }
    },
  });

try {
  await normal.runPromise(migrate);
  await normal.runPromise(seed({ threads: 32, turns: 8, longTurns: 2048, textBytes: 256 }));
  await normal.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agent_bus_calls(id,source_thread_id,tool,arguments,status,target_thread_id,target_turn_id,hops,notify,notify_status,completed_at)
      SELECT md5('notification-'||n)::uuid,${ids.thread}::uuid,'send_message','{}','completed',${ids.thread}::uuid,
        md5('turn-1-1')::uuid,1,true,'pending',now() FROM generate_series(1,256)n`;
      yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash)
      SELECT md5('auth-worker-'||n)::uuid,${ids.owner}::uuid,'Synthetic',md5(n::text) FROM generate_series(1,10000)n`;
      yield* sql`ANALYZE`;
    }),
  );
  const secretRefs: Record<string, string> = {};

  for (let i = 0; i < 24; i++)
    secretRefs[`p-${i}`] = await normal.runPromise(
      GatewayStore.use((s) =>
        s.putSecret({
          ownerUserId: ids.owner,
          name: `synthetic-${i}`,
          plaintext: "synthetic-value",
          createdBy: ids.owner,
        }),
      ),
    );
  await normal.runPromise(
    GatewayStore.use((s) =>
      s.setWorkerConfig(
        ids.worker,
        {
          profiles: Array.from({ length: 24 }, (_, n) => ({ id: `p-${n}` })),
        },
        ids.owner,
        secretRefs,
      ),
    ),
  );

  const results: object[] = [];

  for (const op of operations) {
    const times: number[] = [];

    for (let i = 0; i < 22; i++) {
      const start = performance.now();
      await op.run(normal);

      if (i >= 2) times.push(performance.now() - start);
    }

    recorder.samples = [];
    await op.run(diagnostic);
    const samples = recorder.samples;
    recorder.samples = undefined;
    results.push({
      operation: op.name,
      p95Ms: times.toSorted((a, b) => a - b)[18],
      queries: samples.length,
      rows: samples.reduce((n, s) => n + s.rows, 0),
      decodedJsonBytes: samples.reduce((n, s) => n + s.bytes, 0),
      plans: await explain(normal, samples),
    });
  }

  console.log(
    JSON.stringify(
      {
        baseline,
        iterations: 20,
        warmups: 2,
        targets: 32,
        notifications: 256,
        secrets: 24,
        workers: 10013,
        method:
          "Serial store operations on private PostgreSQL18, pool8, max_connections40; 2048-turn thread. First notification page and complete read are reported separately; payload bytes are decoded JSON size.",
        results,
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
