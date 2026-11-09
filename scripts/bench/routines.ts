import { SQL } from "bun";
import { migrate } from "@canopy/db";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { BotStore } from "../../apps/gateway/src/bots/store.ts";
import { database } from "./database.ts";
import { runtime } from "./runtime.ts";
import { ids, seed } from "./seed.ts";
import { Recorder } from "./trace.ts";
import { PlanCapture } from "./plan-capture.ts";

if (!process.argv.includes("--run")) throw new Error("Opt in with --run; only a new private database is used");

const owned = await database();
const normal = runtime(owned.url);
const recorder = new Recorder();
const diagnostic = runtime(owned.url, recorder);
const observer = new SQL(owned.url);
const p95 = (times: number[]) => times.toSorted((a, b) => a - b)[18];

const prepare = () =>
  normal.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM bot_turns WHERE routine_id IS NOT NULL`;
      yield* sql`UPDATE bot_routines SET next_run_at=now()-interval '1 minute',run_count=0`;
    }),
  );

const run = (r = normal) => r.runPromise(BotStore.use((s) => s.deliverRoutines(ids.owner, new Date())));

try {
  await normal.runPromise(migrate);
  await normal.runPromise(seed({ threads: 8, turns: 8, longTurns: 32, textBytes: 256 }));
  await normal.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO bot_routines(id,bot_id,title,instructions,cron,timezone,schedule_text,next_run_at,hops)
      SELECT md5('routine-'||b.id||'-'||n)::uuid,b.id,'Synthetic','Synthetic','*/15 * * * *','UTC','Synthetic',now(),1
      FROM bots b CROSS JOIN generate_series(1,4)n`;
      yield* sql`ANALYZE`;
    }),
  );
  const times: number[] = [];

  for (let i = 0; i < 22; i++) {
    await prepare();
    const start = performance.now();
    await run();

    if (i >= 2) times.push(performance.now() - start);
  }

  await prepare();
  recorder.samples = [];
  recorder.planCapture = new PlanCapture();
  await run(diagnostic);
  const samples = recorder.samples;
  recorder.samples = undefined;
  // A private trigger simulates 5 ms of enqueue work per occurrence while row locks are held.
  await observer.unsafe(`CREATE FUNCTION bench_routine_delay() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.routine_id IS NOT NULL THEN PERFORM pg_sleep(0.005); END IF; RETURN NEW; END $$`);
  await observer.unsafe(
    `CREATE TRIGGER bench_routine_delay BEFORE INSERT ON bot_turns FOR EACH ROW EXECUTE FUNCTION bench_routine_delay()`,
  );
  const last = (await observer<{ id: string }[]>`SELECT id FROM bots ORDER BY id DESC LIMIT 1`)[0]!.id;
  const edits: number[] = [];

  for (let i = 0; i < 22; i++) {
    await prepare();
    const firing = run();
    let entered = false;

    try {
      for (let n = 0; n < 1000; n++) {
        const rows = await observer`SELECT 1 FROM pg_stat_activity
          WHERE application_name='canopy-db-bench' AND wait_event='PgSleep'`;

        if (rows.length) {
          entered = true;
          break;
        }

        await Bun.sleep(1);
      }

      if (!entered) throw new Error("Routine enqueue delay was not observed");
      const start = performance.now();
      await observer`UPDATE bots SET updated_at=now() WHERE id=${last}::uuid`;

      if (i >= 2) edits.push(performance.now() - start);
    } finally {
      await firing;
    }
  }

  const counts = await observer`SELECT count(*)::int AS queued FROM bot_turns WHERE routine_id IS NOT NULL`;
  console.log(
    JSON.stringify(
      {
        iterations: 20,
        warmups: 2,
        bots: 16,
        routinesPerBot: 4,
        dispatchP95Ms: p95(times),
        concurrentEditP95Ms: p95(edits),
        queued: counts[0]!.queued,
        queries: samples.length,
        rows: samples.reduce((n, s) => n + s.rows, 0),
        decodedJsonBytes: samples.reduce((n, s) => n + s.bytes, 0),
        plans: recorder.planCapture.plans,
        method:
          "Private PostgreSQL18, pool8/max40. Serial production BotStore dispatch, 2 warmups+20 samples. Separate diagnostic EXPLAIN ANALYZE with rollback. Separate contention pass: 5ms INSERT trigger per occurrence; edit last bot after observing PgSleep in first enqueue. Edit latency includes row-lock wait; total dispatch has no artificial delay. Rearm outside timing.",
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await observer.close();
    await diagnostic.dispose();
    await normal.dispose();
  } finally {
    await owned.stop();
  }
}
