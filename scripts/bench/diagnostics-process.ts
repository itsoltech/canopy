import { Schema } from "effect";
import { BenchReply, type BenchCommand, type BenchStats } from "./diagnostics-protocol.ts";

/** A separate gateway process keeps driver CPU out of collector measurements. */
export async function diagnosticsProcess(env: Record<string, string | undefined>) {
  let id = 0;
  let markReady!: () => void;
  let failReady!: (cause: Error) => void;

  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });

  const pending = new Map<number, { resolve(value: BenchStats): void; reject(cause: Error): void }>();

  const profileDirectory = env["CANOPY_BENCH_PROFILE_DIR"];
  const profile = profileDirectory ? ["--cpu-prof", "--cpu-prof-md", `--cpu-prof-dir=${profileDirectory}`] : [];

  const child = Bun.spawn([process.execPath, ...profile, `${import.meta.dir}/diagnostics-entry.ts`], {
    env,
    stdout: "ignore",
    stderr: "inherit",
    ipc(message) {
      const reply = Schema.decodeUnknownSync(BenchReply)(message);

      if (!reply.id) {
        markReady();

        return;
      }

      const request = pending.get(reply.id);
      pending.delete(reply.id);

      if (!reply.error && reply.stats) request?.resolve(reply.stats);
      else request?.reject(new Error("Diagnostics benchmark command failed"));
    },
  });

  void child.exited.then(() => {
    failReady(new Error("Benchmark gateway exited"));

    for (const request of pending.values()) request.reject(new Error("Benchmark gateway exited"));
    pending.clear();
  });
  await ready;

  const run = (action: BenchCommand["action"]) =>
    new Promise<BenchStats>((resolve, reject) => {
      const request = { id: ++id, action };
      pending.set(request.id, { resolve, reject });
      child.send(request);
    });

  return {
    run,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;

      try {
        await run("stop");
        await child.exited;
      } finally {
        if (child.exitCode === null) child.kill("SIGTERM");
      }
    },
  };
}
