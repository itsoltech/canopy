import { migrate } from "@canopy/db";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore, encryptSecret } from "../../apps/gateway/src/store/index.ts";
import { database } from "./database.ts";
import { runtime, type BenchRuntime } from "./runtime.ts";
import { ids, seed } from "./seed.ts";
import { PlanCapture } from "./plan-capture.ts";
import { Recorder } from "./trace.ts";
import { baselineSecrets } from "./secret-baseline.ts";

if (!process.argv.includes("--run")) throw new Error("Opt in with --run; only a new private database is used");

const churn = process.argv.includes("--churn");
const owned = await database();
const normal = runtime(owned.url);
const recorder = new Recorder();
const diagnostic = runtime(owned.url, recorder);
const ciphertext = encryptSecret(Buffer.alloc(32, 1), "Synthetic benchmark value");

const fixtures = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO thread_secrets(id,thread_id,turn_id,call_id,label,description,status,ciphertext,key_id,expires_at,revision,applied_revision)
    SELECT md5('queue-secret-'||n)::uuid,${ids.thread}::uuid,md5('turn-1-1')::uuid,md5('queue-call-'||n)::uuid,
      'Synthetic','Synthetic','saved',${ciphertext},'primary',now()+interval '1 day',1,0
      FROM generate_series(1,1024)n`;
  yield* sql`ANALYZE`;
});

const prepare = (name: string) =>
  normal.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM worker_secret_replays`;
      yield* sql`INSERT INTO worker_secret_delivery_cursors(worker_id,last_id) VALUES(${ids.worker}::uuid,NULL)
        ON CONFLICT(worker_id) DO UPDATE SET last_id=NULL`;
      yield* sql`UPDATE thread_secrets SET status='saved',ciphertext=${ciphertext},key_id='primary',revision=1,
    applied_revision=${name === "secrets/reset" ? 1 : 0},
    expires_at=now()+make_interval(secs=>${name === "secrets/expire" ? -60 : 86400})`;

      if (!churn) yield* sql`VACUUM (ANALYZE) thread_secrets`;
    }),
  );

const run = (r: BenchRuntime, name: string, baseline: boolean) =>
  r.runPromise(
    baseline
      ? SqlClient.SqlClient.use((sql) => baselineSecrets(sql, Buffer.alloc(32, 1), ids.worker, name))
      : GatewayStore.use((s) =>
          name === "secrets/expire"
            ? s.expireSecrets(ids.owner).pipe(Effect.map((rows) => rows.length))
            : s.secretDeliveries(ids.worker, name === "secrets/reset").pipe(Effect.map((rows) => rows.length)),
        ),
  );

try {
  await normal.runPromise(migrate);
  await normal.runPromise(seed({ threads: 8, turns: 8, longTurns: 32, textBytes: 256 }));
  await normal.runPromise(fixtures);
  const results: object[] = [];

  for (const name of ["secrets/poll", "secrets/reset", "secrets/expire"]) {
    const modes: { baseline: boolean; times: number[]; rounds: number[]; delivered: number }[] = [true, false].map(
      (baseline) => ({ baseline, times: [], rounds: [], delivered: 0 }),
    );

    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 22; i++) {
        for (const mode of (round + i) % 2 ? modes.toReversed() : modes) {
          if (churn || name !== "secrets/poll" || i === 0) await prepare(name);
          const start = performance.now();
          mode.delivered = await run(normal, name, mode.baseline);

          if (i >= 2) mode.times.push(performance.now() - start);
        }
      }

      for (const mode of modes) mode.rounds.push(mode.times.slice(-20).toSorted((a, b) => a - b)[18]!);
    }

    for (const { baseline, times, rounds, delivered } of modes) {
      await prepare(name);
      recorder.samples = [];
      recorder.planCapture = new PlanCapture();
      await run(diagnostic, name, baseline);
      const samples = recorder.samples;
      recorder.samples = undefined;
      results.push({
        operation: name,
        baseline,
        p95Ms: times.toSorted((a, b) => a - b)[56],
        roundP95Ms: rounds,
        delivered,
        queries: samples.length,
        rows: samples.reduce((n, s) => n + s.rows, 0),
        decodedJsonBytes: samples.reduce((n, s) => n + s.bytes, 0),
        plans: recorder.planCapture.plans,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        iterations: 20,
        rounds: 3,
        churn,
        warmups: 2,
        results,
        method:
          "Private PostgreSQL18;1024 synthetic saved secrets. Alternate baseline/current each sample in3 rounds. Default:stable polling;reset/expiry rearmed and vacuumed outside latency. --churn rearms every sample without vacuum to expose update/index bloat. Reset simulates one reconnect;expire measures first batch. Serial store calls;separate rolled-back EXPLAIN ANALYZE. JSON bytes exclude decrypted return values.",
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
