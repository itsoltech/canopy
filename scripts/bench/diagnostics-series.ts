import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { waitForSystemJobs } from "./diagnostics-host.ts";
import { MemberResult, pairResult } from "./diagnostics-series-result.ts";

/** Every member gets a fresh driver VM, PG cluster, database and gateway/worker filesystem state. */
const shutdown = new AbortController();
let active: ReturnType<typeof Bun.spawn> | undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    shutdown.abort(new Error("Benchmark stopped by its owner"));
    active?.kill("SIGTERM");
  });

async function member(pair: number, attempt: number, on: boolean) {
  shutdown.signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "canopy-diagnostics-member-"));
  await chmod(directory, 0o700);
  let result: typeof MemberResult.Type | undefined;

  try {
    active = Bun.spawn([process.execPath, join(import.meta.dir, "diagnostics.ts")], {
      env: {
        ...process.env,
        TMPDIR: directory,
        CANOPY_BENCH_STATE_DIR: directory,
        CANOPY_BENCH_MEMBER: on ? "B" : "A",
        CANOPY_BENCH_PAIR: String(pair),
        CANOPY_BENCH_ATTEMPT: String(attempt),
      },
      stdout: "inherit",
      stderr: "inherit",
      ipc(message) {
        result = Schema.decodeUnknownSync(MemberResult)(message);
      },
    });
    const code = await active.exited;

    if (code !== 0 || !result) throw new Error("Fresh benchmark member failed before completing host checks");

    return result;
  } finally {
    if (active?.exitCode === null && active.signalCode === null) {
      active.kill("SIGTERM");
      await active.exited;
    }

    active = undefined;
    await rm(directory, { recursive: true, force: true });
  }
}

const series = Number(process.env["CANOPY_BENCH_SERIES"] ?? 4);

console.info(
  JSON.stringify({
    phase: "protocol",
    isolation: "fresh-driver-cluster-state-per-member",
    control: process.env["CANOPY_BENCH_CONTROL"] === "1",
    series,
  }),
);

for (let pair = 1; pair <= series; pair++) {
  let accepted = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    await waitForSystemJobs(shutdown.signal);
    const members: (typeof MemberResult.Type)[] = [];

    for (const on of pair % 2 ? [false, true] : [true, false]) {
      const result = await member(pair, attempt, on);
      members.push(result);

      if (!result.accepted) break;
    }

    const result = pairResult(pair, attempt, members);
    console.info(JSON.stringify(result));
    accepted = result.accepted;

    if (accepted) break;
  }

  if (!accepted) throw new Error("Three rejected attempts: a quiet measurement window is unavailable");
}
