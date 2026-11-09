import { create } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { migrate } from "@canopy/db";
import { SqlClient } from "effect/sql";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { Redirects } from "../../apps/gateway/src/computers/redirects.ts";
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
const home = "b".repeat(64);
const former = "c".repeat(64);

const redirects = (r: BenchRuntime) =>
  new Redirects(new ComputerStore(r, ids.owner, Buffer.alloc(32, 1)), () => "a".repeat(64));

const items = Array.from({ length: 256 }, (_, n) =>
  create(link.MovedItemSchema, {
    itemId: Bun.randomUUIDv7(),
    kind: n % 2 ? "bot" : "thread",
    homeNodeId: home,
    homeName: "Synthetic",
    fromNodeId: former,
    movedAtMs: 1_000_000n,
  }),
);

const prepare = () =>
  normal.runPromise(
    SqlClient.SqlClient.use((sql) => sql`DELETE FROM computer_redirects WHERE owner_user_id=${ids.owner}::uuid`),
  );

try {
  await normal.runPromise(migrate);
  await normal.runPromise(seed({ threads: 8, turns: 8, longTurns: 32, textBytes: 256 }));
  const results: object[] = [];

  for (const replay of [false, true]) {
    const times: number[] = [];
    const rounds: number[] = [];
    const current = redirects(normal);

    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 22; i++) {
        if (!replay) await prepare();
        await current.load();

        if (replay) await current.learn(former, items);

        const start = performance.now();
        await current.learn(former, items);

        if (i >= 2) times.push(performance.now() - start);
      }

      rounds.push(times.slice(-20).toSorted((a, b) => a - b)[18]!);
    }

    if (!replay) await prepare();
    const traced = redirects(diagnostic);
    await traced.load();
    recorder.samples = [];
    recorder.planCapture = new PlanCapture();
    await traced.learn(former, items);
    const samples = recorder.samples;
    recorder.samples = undefined;
    results.push({
      operation: replay ? "redirects/handshake-replay-256" : "redirects/learn-256",
      p95Ms: times.toSorted((a, b) => a - b)[56],
      roundP95Ms: rounds,
      queries: samples.length,
      rows: samples.reduce((n, s) => n + s.rows, 0),
      decodedJsonBytes: samples.reduce((n, s) => n + s.bytes, 0),
      plans: recorder.planCapture.plans,
    });
  }

  console.log(
    JSON.stringify(
      {
        rounds: 3,
        iterations: 20,
        warmups: 2,
        results,
        method:
          "Private PostgreSQL18,pool8,max40.256 notices,half bots and half threads,no local live targets.Three rounds;fresh state or identical handshake replay;reset/load outside timing.Real Redirects service without transport.Separate rolled-back EXPLAIN ANALYZE.JSON bytes are decoded representation.",
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
