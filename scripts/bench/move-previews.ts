import { create } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { migrate } from "@canopy/db";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayCore } from "../../apps/gateway/src/core/core.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { ComputerMoves } from "../../apps/gateway/src/computers/moves.ts";
import { Redirects } from "../../apps/gateway/src/computers/redirects.ts";
import { movesInspect, movesPreviewBot } from "../../apps/gateway/src/computers/moves-preview.ts";
import { database } from "./database.ts";
import { runtime, type BenchRuntime } from "./runtime.ts";
import { ids, seed } from "./seed.ts";
import { Recorder } from "./trace.ts";
import { PlanCapture } from "./plan-capture.ts";

if (!process.argv.includes("--run")) throw new Error("Opt in with --run; only a new private database is used");

const owned = await database();
const normal = runtime(owned.url);
const recorder = new Recorder();
const diagnostic = runtime(owned.url, recorder);
const cores: GatewayCore[] = [];
const botId = Bun.MD5.hash("bot-1", "hex");

function context(r: BenchRuntime) {
  const store = new ComputerStore(r, ids.owner, Buffer.alloc(32, 1));
  const core = new GatewayCore({ runtime: r, userId: ids.owner, instanceId: "bench-move-preview" });
  core.secrets.stop();
  cores.push(core);

  return new ComputerMoves(store, {
    core,
    redirects: new Redirects(store, () => "a".repeat(64)),
    self: () => ({ nodeId: "a".repeat(64), name: "Synthetic" }),
    name: async () => "Synthetic peer",
    unavailable: async () => "",
    ready: () => true,
    call: async function* () {
      yield create(link.MoveInspectionSchema);
    },
    broadcast: () => {},
  });
}

try {
  await normal.runPromise(migrate);
  await normal.runPromise(seed({ threads: 8, turns: 8, longTurns: 32, textBytes: 256 }));

  const refs = await normal.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO bot_turns(id,bot_id,client_request_id,input,status,finished_at)
      SELECT md5('preview-turn-'||n)::uuid,${botId}::uuid,'preview-'||n,'Synthetic','completed',now()
      FROM generate_series(1,2048)n`;
      yield* sql`INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,text)
      SELECT md5('preview-message-'||id)::uuid,bot_id,id,'reply','agent','user',repeat('x',4096)
      FROM bot_turns WHERE client_request_id LIKE 'preview-%'`;
      yield* sql`INSERT INTO connector_accounts(id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,status,all_bots)
      SELECT md5('preview-account-'||n)::uuid,${ids.owner}::uuid,'github','Synthetic '||n,'preview_'||n,
        'https://example.invalid','http','headers','connected',true FROM generate_series(1,32)n`;
      yield* sql`ANALYZE`;

      return yield* sql<{
        kind: string;
        id: string;
      }>`SELECT 'bot' AS kind,id FROM bots UNION ALL SELECT 'thread',id FROM threads`;
    }),
  );

  const contexts = new Map([
    [normal, context(normal)],
    [diagnostic, context(diagnostic)],
  ]);

  const results: object[] = [];

  for (const name of ["moves/bot-preview", "moves/inspect-24-items"]) {
    const run = (r: BenchRuntime) =>
      name === "moves/bot-preview"
        ? movesPreviewBot(contexts.get(r)!, botId)
        : movesInspect(contexts.get(r)!, "b".repeat(64), refs);

    const times: number[] = [];

    for (let i = 0; i < 22; i++) {
      const start = performance.now();
      await run(normal);

      if (i >= 2) times.push(performance.now() - start);
    }

    recorder.samples = [];
    recorder.planCapture = new PlanCapture();
    await run(diagnostic);
    const samples = recorder.samples;
    recorder.samples = undefined;
    results.push({
      operation: name,
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
        results,
        method:
          "Private PostgreSQL18,pool8,max40. Real move preview/inspection without transport; synthetic inspection reply only. One bot has2048 additional4KiB messages;32 connector names. Inspection covers16bots+8threads. Separate rolled-back EXPLAIN ANALYZE; decoded JSON representation bytes.",
      },
      null,
      2,
    ),
  );
} finally {
  try {
    for (const core of cores) {
      await core.stopSweep();
      await core.bots.stop();
      await core.link.shutdown();
    }

    await diagnostic.dispose();
    await normal.dispose();
  } finally {
    await owned.stop();
  }
}
