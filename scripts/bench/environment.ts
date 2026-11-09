import { create } from "@bufbuild/protobuf";
import { SkillFileSchema, ui } from "@canopy/contracts";
import { migrate } from "@canopy/db";
import { validateSkillFiles } from "@canopy/domain/skill-artifact";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { AgentEnvironment } from "../../apps/gateway/src/agent-environment/service.ts";
import { addSkillVersion, saveSkillDefinition } from "../../apps/gateway/src/agent-environment/skill-database.ts";
import { workerEnvironment } from "../../apps/gateway/src/agent-environment/worker-settings.ts";
import { createWorkerLink } from "../../apps/gateway/src/worker-link/index.ts";
import { database } from "./database.ts";
import { runtime, type BenchRuntime } from "./runtime.ts";
import { ids, seed } from "./seed.ts";
import { Recorder } from "./trace.ts";
import { PlanCapture } from "./plan-capture.ts";
import type { Operation } from "./operations.ts";
import { createHash } from "node:crypto";

if (!process.argv.includes("--run")) throw new Error("Opt in with --run; only a new private database is used");

const owned = await database();
const normal = runtime(owned.url);
const recorder = new Recorder();
const diagnostic = runtime(owned.url, recorder);
const link = createWorkerLink({ authenticate: async () => undefined, welcome: async () => ({}) });

const environment = (r: BenchRuntime) =>
  new AgentEnvironment({ runtime: r, userId: ids.owner, link, changed: () => {} });

const fixtures = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO worker_environments(worker_id,supported,skills_supported)
    SELECT id,true,true FROM workers`;

  for (let n = 1; n <= 32; n++) {
    const id = Bun.randomUUIDv7();
    let current;

    for (const version of [1n, 2n]) {
      current = validateSkillFiles([
        create(SkillFileSchema, {
          path: "SKILL.md",
          content: Buffer.from(
            `---\nname: bench-skill-${n}\ndescription: Synthetic benchmark skill.\n---\nVersion ${version}\n${"x".repeat(16384)}`,
          ),
        }),
      ]);
      yield* addSkillVersion(sql, ids.owner, id, version, current);
    }

    yield* saveSkillDefinition(
      sql,
      ids.owner,
      create(ui.LibrarySkillSchema, {
        id,
        name: `Synthetic ${n}`,
        version: 2n,
        versions: [1n, 2n],
        artifact: current,
        harnesses: ["codex"],
        platformHome: true,
        selector: { everyone: true },
        overrides: n % 2 ? [{ workerId: ids.worker, version: 1n }] : [],
      }),
    );
  }

  yield* sql`ANALYZE`;
});

const operations: Operation[] = [
  {
    name: "environment/snapshot-32-skills-13-workers",
    run: async (r) => {
      await environment(r).snapshot();
    },
  },
  {
    name: "environment/worker-settings-32-skills",
    run: async (r) => {
      await workerEnvironment(environment(r), ids.worker);
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
    const rounds: object[] = [];

    for (let round = 0; round < (process.argv.includes("--profile") ? 3 : 1); round++) {
      const cpu = process.cpuUsage();
      const roundTimes: number[] = [];

      for (let i = 0; i < 22; i++) {
        const start = performance.now();
        await operation.run(normal);

        if (i >= 2) roundTimes.push(performance.now() - start);
      }

      times.push(...roundTimes);
      const usage = process.cpuUsage(cpu);
      rounds.push({
        p50Ms: roundTimes.toSorted((a, b) => a - b)[9],
        p95Ms: roundTimes.toSorted((a, b) => a - b)[18],
        cpuMsIncludingWarmups: (usage.user + usage.system) / 1000,
      });
    }

    // Driver wall time includes pool/transport/decoding, but excludes our JSON byte accounting.
    recorder.samples = [];
    recorder.planCapture = undefined;
    const profileStart = performance.now();
    await operation.run(diagnostic);
    const profileTotalMs = performance.now() - profileStart;

    const profile = recorder.samples.map((sample) => ({
      fingerprint: createHash("sha256").update(sample.text).digest("hex").slice(0, 16),
      rows: sample.rows,
      decodedJsonBytes: sample.bytes,
      driverWallMs: sample.elapsedMs,
    }));

    recorder.samples = [];
    recorder.planCapture = new PlanCapture();
    await operation.run(diagnostic);
    const samples = recorder.samples;
    recorder.samples = undefined;
    results.push({
      operation: operation.name,
      p95Ms: times.toSorted((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1],
      rounds,
      queries: samples.length,
      rows: samples.reduce((n, s) => n + s.rows, 0),
      decodedJsonBytes: samples.reduce((n, s) => n + s.bytes, 0),
      plans: recorder.planCapture.plans,
      ...(process.argv.includes("--profile") && { profileTotalMs, profile }),
    });
  }

  console.log(
    JSON.stringify(
      {
        iterationsPerRound: 20,
        rounds: process.argv.includes("--profile") ? 3 : 1,
        warmups: 2,
        results,
        method:
          "Private PostgreSQL18;32 skills with2 immutable16KiB versions;13 offline workers;16 historical pins on selected worker. Real environment service without transport. Serial latency without tracing; separate EXPLAIN ANALYZE. JSON bytes are decoded representation.",
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
