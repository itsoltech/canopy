import { migrate } from "@canopy/db";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { parseArgs } from "node:util";
import { database } from "./database.ts";
import { explain } from "./explain.ts";
import { operations, seedMirrors } from "./operations.ts";
import { runtime } from "./runtime.ts";
import { seed, type Dataset } from "./seed.ts";
import { Recorder } from "./trace.ts";
import { stats, difference } from "./stats.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    run: { type: "boolean" },
    threads: { type: "string", default: "240" },
    turns: { type: "string", default: "32" },
    "long-turns": { type: "string", default: "2048" },
    "agent-tail": { type: "string", default: "0" },
    "text-bytes": { type: "string", default: "4096" },
    iterations: { type: "string", default: "20" },
    operation: { type: "string" },
    explain: { type: "boolean" },
  },
});

if (!values.run) throw new Error("Opt in with --run. This starts and removes a private PostgreSQL 18 container.");

function integer(value: string, name: string, maximum: number, minimum = 1) {
  const n = Number(value);

  if (!Number.isSafeInteger(n) || n < minimum || n > maximum)
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);

  return n;
}

const size: Dataset = {
  threads: integer(values.threads, "threads", 2000),
  turns: integer(values.turns, "turns", 1000),
  longTurns: integer(values["long-turns"], "long-turns", 10000),
  agentTail: integer(values["agent-tail"], "agent-tail", 10000, 0),
  textBytes: integer(values["text-bytes"], "text-bytes", 65536),
};

const iterations = integer(values.iterations, "iterations", 200);

if ((size.threads * size.turns + size.longTurns) * size.textBytes > 512 * 1024 ** 2)
  throw new Error("Dataset content exceeds 512 MiB before events/indexes; reduce size options");

const selected = operations(size).filter((op) => !values.operation || op.name.includes(values.operation));

if (!selected.length) throw new Error("No benchmark operations match --operation");

const owned = await database();
const normal = runtime(owned.url);
const recorder = new Recorder();
const diagnostic = runtime(owned.url, recorder);

const percentile = (samples: number[], p: number) =>
  samples.toSorted((a, b) => a - b)[Math.ceil(samples.length * p) - 1]!;

try {
  console.error("Migrating and seeding synthetic data…");
  await normal.runPromise(migrate);
  await normal.runPromise(seed(size));
  await normal.runPromise(seedMirrors(size));
  const results: object[] = [];

  for (const operation of selected) {
    console.error(`Measuring ${operation.name}`);

    for (let i = 0; i < 2; i++) await operation.run(normal);
    const times: number[] = [];
    const before = await normal.runPromise(stats);

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await operation.run(normal);
      times.push(performance.now() - start);
    }

    const after = await normal.runPromise(stats);

    recorder.samples = [];
    await operation.run(diagnostic);
    const samples = recorder.samples;
    recorder.samples = undefined;
    results.push({
      operation: operation.name,
      p50Ms: percentile(times, 0.5),
      p95Ms: percentile(times, 0.95),
      queries: samples.length,
      rows: samples.reduce((n, s) => n + s.rows, 0),
      decodedJsonBytes: samples.reduce((n, s) => n + s.bytes, 0),
      serverPerIteration: difference(before, after, iterations),
      ...(values.explain ? { plans: await explain(normal, samples) } : undefined),
    });
  }

  const storage = await normal.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return (yield* sql<{ bytes: string; version: string }>`SELECT pg_database_size(current_database())::text AS bytes,
      current_setting('server_version') AS version`)[0]!;
    }),
  );

  console.log(
    JSON.stringify(
      {
        dataset: size,
        iterations,
        warmups: 2,
        postgres: storage.version,
        storageBytes: storage.bytes,
        measurement:
          "Serial store operations; latency without tracing; separate diagnostic pass includes transaction controls. Bytes are decoded JSON size, not wire or disk I/O.",
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
