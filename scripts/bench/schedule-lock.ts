import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { migrate } from "@canopy/db";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { AgentBusStore } from "../../apps/gateway/src/store/index.ts";
import { database } from "./database.ts";
import { runtime } from "./runtime.ts";
import { ids, seed } from "./seed.ts";

if (!process.argv.includes("--run")) throw new Error("Opt in with --run; only a private database is used");

const owned = await database();
const normal = runtime(owned.url);
const samples: number[] = [];
let queued = 0;

try {
  await normal.runPromise(migrate);
  await normal.runPromise(seed({ threads: 8, turns: 8, longTurns: 40, textBytes: 256 }));

  const placement = await normal.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return (yield* sql<{
        id: string;
        project_id: string;
      }>`SELECT id,project_id FROM project_workspaces ORDER BY id LIMIT 1`)[0]!;
    }),
  );

  for (let i = 0; i < 22; i++) {
    const now = new Date();

    const schedule = await normal.runPromise(
      AgentBusStore.use((store) =>
        store.createUserSchedule({
          userId: ids.owner,
          schedule: {
            threadId: "",
            kind: "once",
            prompt: "Synthetic schedule",
            runAt: now,
            nextRunAt: now,
            timezone: "UTC",
            hops: 0,
            newThread: create(ui.NewThreadScheduleSchema, {
              projectId: placement.project_id,
              workspaceId: placement.id,
              placement: "specific",
              provider: Provider.CODEX,
            }),
          },
        }),
      ),
    );

    const claimed = await normal.runPromise(
      AgentBusStore.use((store) => store.claimDueSchedules("benchmark", now, 180)),
    );

    let entered = () => {};

    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const firing = normal.runPromise(
      AgentBusStore.use((store) =>
        store.fireSchedule({
          schedule: claimed.find((row) => row.id === schedule.id)!,
          input: { note: "scheduled", message: schedule.prompt },
          run: true,
          nextRunAt: undefined,
          eligibleWorkerIds: [ids.worker],
          now,
          prepareWorkspace: async (request) => {
            entered();
            await Bun.sleep(50);

            return request;
          },
        }),
      ),
    );

    await preparing;
    const start = performance.now();
    await normal.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE schedules SET version=version+1 WHERE id=${schedule.id}::uuid`;
      }),
    );
    const elapsed = performance.now() - start;
    const fired = await firing;

    if (i >= 2) {
      samples.push(elapsed);

      if (fired.turn) queued++;
    }

    await normal.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE schedules SET status='cancelled',next_run_at=NULL WHERE id=${schedule.id}::uuid`;
      }),
    );
  }

  const sorted = samples.toSorted((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        iterations: samples.length,
        warmups: 2,
        workspaceDelayMs: 50,
        editP50Ms: sorted[9],
        editP95Ms: sorted[18],
        queuedDespiteConcurrentEdit: queued,
        method:
          "Concurrent version edit starts after workspace preparation begins. Its latency includes schedule row lock wait; 50 ms synthetic external I/O. Private PostgreSQL 18, 40 connections, pool 8.",
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await normal.dispose();
  } finally {
    await owned.stop();
  }
}
