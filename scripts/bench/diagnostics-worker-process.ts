import { Schema } from "effect";
import { WorkerBenchReply, type BenchCommand, type ProcessStats } from "./diagnostics-protocol.ts";

/** Keep worker resource accounting separate from both the gateway and load driver. */
export async function diagnosticsWorker(env: Record<string, string | undefined>) {
  let id = 0;
  let ready!: () => void;
  let rejectReady!: (cause: Error) => void;

  const started = new Promise<void>((resolve, reject) => {
    ready = resolve;
    rejectReady = reject;
  });

  const pending = new Map<number, { resolve(value: typeof ProcessStats.Type): void; reject(cause: Error): void }>();

  const child = Bun.spawn([process.execPath, `${import.meta.dir}/diagnostics-worker.ts`], {
    env,
    stdout: "ignore",
    stderr: "inherit",
    ipc(message) {
      const reply = Schema.decodeUnknownSync(WorkerBenchReply)(message);

      if (!reply.id) {
        ready();

        return;
      }

      const request = pending.get(reply.id);
      pending.delete(reply.id);

      if (reply.stats) request?.resolve(reply.stats);
    },
  });

  void child.exited.then(() => {
    const cause = new Error("Benchmark worker exited");
    rejectReady(cause);

    for (const request of pending.values()) request.reject(cause);
    pending.clear();
  });
  await started;

  const run = (action: BenchCommand["action"]) =>
    new Promise<typeof ProcessStats.Type>((resolve, reject) => {
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
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }
    },
  };
}
