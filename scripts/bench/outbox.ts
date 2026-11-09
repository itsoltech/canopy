import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { CommandSchema } from "@canopy/contracts";
import { migrate } from "@canopy/db";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore } from "../../apps/gateway/src/store/index.ts";
import type { OutboxRow } from "../../apps/gateway/src/store/rows.ts";
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

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  for (let offset = 0; offset < 4096; offset += 128) {
    const rows = Array.from({ length: 128 }, (_, n) => {
      const id = Bun.MD5.hash(`outbox-${offset + n}`, "hex");
      const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;

      const payload = toBinary(
        CommandSchema,
        create(CommandSchema, { commandId: uuid, kind: { case: "unloadThread", value: { threadId: ids.thread } } }),
      );

      return { id: uuid, ordinal: offset + n, payload: Buffer.from(payload).toString("base64") };
    });

    yield* sql`INSERT INTO worker_commands(id,worker_id,thread_id,kind,payload,expires_at,created_at)
      SELECT id::uuid,${ids.worker}::uuid,${ids.thread}::uuid,'unloadThread',decode(payload,'base64'),
        now()+interval '1 day',now()-make_interval(secs=>ordinal::double precision/1000)
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) r(id text,ordinal int,payload text)`;
  }

  yield* sql`INSERT INTO worker_commands(id,worker_id,kind,payload,status,expires_at,completed_at)
    SELECT md5('outbox-done-'||n)::uuid,${ids.worker}::uuid,'unloadThread',''::bytea,'completed',
      now()-interval '8 days',now()-interval '8 days' FROM generate_series(1,16384)n`;
  yield* sql`ANALYZE`;
});

const run = async (r: BenchRuntime, baseline: boolean, all: boolean) => {
  if (baseline)
    return (
      await r.runPromise(
        SqlClient.SqlClient.use((sql) =>
          sql<OutboxRow>`SELECT id,worker_id,thread_id,turn_id,kind,payload FROM worker_commands
      WHERE worker_id=${ids.worker}::uuid AND status IN ('pending','delivered') AND expires_at>now()
      ORDER BY created_at`.pipe(Effect.map((rows) => rows.map((row) => fromBinary(CommandSchema, row.payload)))),
        ),
      )
    ).length;

  let after: string | undefined;
  let count = 0;

  for (;;) {
    const page = await r.runPromise(GatewayStore.use((s) => s.pendingCommands(ids.worker, after)));
    count += page.length;

    if (!all || !page.length) return count;
    const next = page.at(-1)!.command.commandId;

    if (next === after) throw new Error("Outbox cursor did not advance");
    after = next;
  }
};

try {
  await normal.runPromise(migrate);
  await normal.runPromise(seed({ threads: 8, turns: 8, longTurns: 32, textBytes: 256 }));
  await normal.runPromise(fixture);
  const results: object[] = [];

  for (const all of [false, true]) {
    const modes: { baseline: boolean; times: number[]; rounds: number[]; returned: number }[] = [true, false].map(
      (baseline) => ({ baseline, times: [], rounds: [], returned: 0 }),
    );

    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 22; i++)
        for (const mode of (round + i) % 2 ? modes.toReversed() : modes) {
          const start = performance.now();
          mode.returned = await run(normal, mode.baseline, all);

          if (i >= 2) mode.times.push(performance.now() - start);
        }

      for (const mode of modes) mode.rounds.push(mode.times.slice(-20).toSorted((a, b) => a - b)[18]!);
    }

    for (const mode of modes) {
      recorder.samples = [];
      recorder.planCapture = new PlanCapture();
      await run(diagnostic, mode.baseline, all);
      const samples = recorder.samples;
      recorder.samples = undefined;
      results.push({
        operation: all ? "outbox/full-read" : "outbox/first-page",
        baseline: mode.baseline,
        p95Ms: mode.times.toSorted((a, b) => a - b)[56],
        roundP95Ms: mode.rounds,
        returned: mode.returned,
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
        warmups: 2,
        results,
        method:
          "Private PostgreSQL18,pool8,max40.4096 pending commands with real protobuf ids plus16384 completed rows. Alternating baseline/current each sample. Baseline is pre-paging SQL/decode. Serial first page and full read, without ACK transport; separate rolled-back EXPLAIN ANALYZE;decoded JSON representation bytes.",
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
