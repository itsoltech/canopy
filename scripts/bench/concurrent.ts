import { create } from "@bufbuild/protobuf";
import { ItemDeltaField, ItemStatus, ThreadEventSchema } from "@canopy/contracts";
import { migrate } from "@canopy/db";
import { Effect } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { Ingest } from "../../apps/gateway/src/store/index.ts";
import { database } from "./database.ts";
import { operations, seedMirrors } from "./operations.ts";
import { queueOperations, seedQueues } from "./queues.ts";
import { runtime } from "./runtime.ts";
import { ids, seed } from "./seed.ts";

const { values } = parseArgs({
  options: {
    run: { type: "boolean" },
    clients: { type: "string", default: "8" },
    pool: { type: "string", default: "10" },
    gateways: { type: "string", default: "1" },
    iterations: { type: "string", default: "40" },
    "statement-timeout-ms": { type: "string", default: "5000" },
  },
});

if (!values.run) throw new Error("Opt in with --run. Only a new, private PostgreSQL container is used.");

function integer(value: string, maximum: number) {
  const result = Number(value);

  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error(`Expected integer 1–${maximum}`);

  return result;
}

const clients = integer(values.clients, 32);
const pool = integer(values.pool, 30);
const gateways = integer(values.gateways, 3);

if (pool * gateways > 36) throw new Error("Reserve at least four of the server's 40 connections for administration");

const iterations = integer(values.iterations, 200);
const statementTimeoutMs = integer(values["statement-timeout-ms"], 60000);
const size = { threads: 64, turns: 16, longTurns: 2048, textBytes: 4096 };
const owned = await database();
const normal = runtime(owned.url, undefined, { pool, statementTimeoutMs });

const pools = [
  normal,
  ...Array.from({ length: gateways - 1 }, () => runtime(owned.url, undefined, { pool, statementTimeoutMs })),
];

const monitor = runtime(owned.url, undefined, { pool: 1 });
const delays = monitorEventLoopDelay({ resolution: 10 });
const timings = new Map<string, number[]>();
const failures = new Map<string, number>();
const failureReasons = new Map<string, number>();
const acquisition: number[] = [];
let sampling = true;
let lockWaitSamples = 0;
let blockers = 0;
let peakConnections = 0;
let peakActive = 0;
let samples = 0;
let sequence = 0n;
const streamingTurn = "30000000-0000-4000-8000-000000000002";
const streamingItem = "concurrent-answer";
const streamingChunk = "synthetic streaming delta ";

const percentile = (input: readonly number[], p: number) =>
  input.toSorted((a, b) => a - b)[Math.ceil(input.length * p) - 1] ?? 0;

async function measured(name: string, work: () => Promise<void>) {
  const start = performance.now();

  try {
    await work();
  } catch (error) {
    failures.set(name, (failures.get(name) ?? 0) + 1);
    const reason = SqlError.isSqlError(error) ? error.reason._tag : "Other";
    failureReasons.set(reason, (failureReasons.get(reason) ?? 0) + 1);
  }

  const list = timings.get(name) ?? [];
  list.push(performance.now() - start);
  timings.set(name, list);
}

async function observe() {
  while (sampling) {
    const row = await monitor.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return (yield* sql<{ connections: number; active: number; locks: number; blockers: number }>`
        SELECT count(*)::int AS connections, count(*) FILTER (WHERE state='active')::int AS active,
          count(*) FILTER (WHERE wait_event_type='Lock')::int AS locks,
          coalesce(sum(cardinality(pg_blocking_pids(pid))),0)::int AS blockers
        FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`)[0]!;
      }),
    );

    samples++;
    peakConnections = Math.max(peakConnections, row.connections);
    peakActive = Math.max(peakActive, row.active);
    lockWaitSamples += row.locks;
    blockers += row.blockers;
    await Bun.sleep(10);
  }
}

async function probe(client: typeof normal) {
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await client.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const connection = yield* sql.reserve;
          acquisition.push(performance.now() - start);
          yield* connection.executeUnprepared("SELECT 1", [], undefined);
        }),
      ),
    );
  }
}

async function stream() {
  for (let i = 0; i < iterations; i++) {
    await measured("stream/ingest-8", async () => {
      const events = Array.from({ length: 8 }, () =>
        create(ThreadEventSchema, {
          eventId: Bun.randomUUIDv7(),
          threadId: ids.thread,
          turnId: streamingTurn,
          journalSeq: ++sequence,
          body: {
            case: "itemDelta",
            value: { itemId: streamingItem, field: ItemDeltaField.TEXT, chunk: streamingChunk },
          },
        }),
      );

      const result = await normal.runPromise(
        Ingest.use((store) => store.ingest(ids.worker, "synthetic-concurrency", events)),
      );

      if (result.failedThreads[0]) throw result.failedThreads[0].error;

      if (result.unknownThreads.length) throw new Error("Ingest did not commit");
    });
  }
}

try {
  console.error("Seeding concurrent workload…");
  await normal.runPromise(migrate);
  await normal.runPromise(seed(size));
  await normal.runPromise(seedMirrors(size));
  await normal.runPromise(seedQueues);
  await normal.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO turns(id,thread_id,ordinal,status,trigger,author_user_id,input,started_at)
      VALUES(${streamingTurn}::uuid,${ids.thread}::uuid,${size.longTurns + 1},'running','user',${ids.owner}::uuid,'{}',now())`;
      yield* sql`UPDATE threads SET status='running' WHERE id=${ids.thread}::uuid`;

      const result = yield* Ingest.use((store) =>
        store.ingest(ids.worker, "synthetic-concurrency", [
          create(ThreadEventSchema, {
            eventId: Bun.randomUUIDv7(),
            threadId: ids.thread,
            turnId: streamingTurn,
            journalSeq: ++sequence,
            body: {
              case: "itemStarted",
              value: {
                item: {
                  itemId: streamingItem,
                  status: ItemStatus.IN_PROGRESS,
                  content: { case: "agentMessage", value: { text: "" } },
                },
              },
            },
          }),
        ]),
      );

      if (result.failedThreads.length || result.unknownThreads.length)
        throw new Error("Streaming fixture did not commit");
    }),
  );
  const all = [...operations(size), ...queueOperations()];

  const polling = all.filter((op) =>
    ["overview/projects", "thread/open-page", "imports/progress", "commands/pending"].includes(op.name),
  );

  const mirror = all.find((op) => op.name === "mirror/write")!;

  for (const client of pools) for (const op of polling) await op.run(client);
  delays.enable();
  const observation = observe();
  const start = performance.now();

  try {
    await Promise.all([
      ...Array.from({ length: clients }, async (_, client) => {
        for (let i = 0; i < iterations; i++) {
          const op = polling[(client + i) % polling.length]!;
          await measured(op.name, () => op.run(pools[client % pools.length]!));
        }
      }),
      stream(),
      (async () => {
        for (let i = 0; i < iterations; i++) await measured(mirror.name, () => mirror.run(pools.at(-1)!));
      })(),
      ...pools.map(probe),
    ]);
  } finally {
    sampling = false;
    await observation;
    delays.disable();
  }

  const elapsedMs = performance.now() - start;

  const streamingVerified = await normal.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return (
        (yield* sql<{ valid: boolean }>`SELECT u.status='running' AND i.status='in_progress'
      AND length(i.content->'agentMessage'->>'text')=${iterations * 8 * streamingChunk.length} AS valid
      FROM turns u JOIN thread_items i ON i.turn_id=u.id WHERE u.id=${streamingTurn}::uuid AND i.item_id=${streamingItem}`)[0]
          ?.valid ?? false
      );
    }),
  );

  if (!streamingVerified) throw new Error("Streaming turn lost deltas or changed status");

  const timeoutCancelled = await normal.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`SET LOCAL statement_timeout = '20ms'`;
            yield* sql`SELECT pg_sleep(0.1)`;

            return false;
          }),
        )
        .pipe(
          Effect.catchTag("SqlError", (error) =>
            error.reason._tag === "StatementTimeoutError" ? Effect.succeed(true) : Effect.fail(error),
          ),
        );
    }),
  );

  console.log(
    JSON.stringify(
      {
        clients,
        pool,
        gateways,
        totalPoolCapacity: pool * gateways,
        streamingVerified,
        maxConnections: 40,
        iterations,
        statementTimeoutMs,
        dataset: size,
        elapsedMs,
        failureReasons: Object.fromEntries(failureReasons),
        timeoutProbe: { cancelled: timeoutCancelled, transaction: "rolled back; SET LOCAL does not leak" },
        results: [...timings].map(([operation, times]) => ({
          operation,
          samples: times.length,
          p50Ms: percentile(times, 0.5),
          p95Ms: percentile(times, 0.95),
          failures: failures.get(operation) ?? 0,
        })),
        poolAcquire: {
          samples: acquisition.length,
          p95Ms: percentile(acquisition, 0.95),
          maxMs: Math.max(...acquisition),
        },
        postgres: { samples, peakConnections, peakActive, lockWaitSamples, blockers },
        eventLoop: { p95Ms: delays.percentile(95) / 1e6, maxMs: delays.max / 1e6 },
        method:
          "Independent gateway SQL pools; concurrent client polls, 8-event batches into a running turn and mirror commits. Lock waits are 10 ms samples, acquisition is a scoped probe including checkout/connection setup. Failures include statement timeouts; no external CLI or transport.",
      },
      null,
      2,
    ),
  );
} finally {
  sampling = false;
  delays.disable();

  try {
    for (const client of pools) await client.dispose();
    await monitor.dispose();
  } finally {
    await owned.stop();
  }
}
