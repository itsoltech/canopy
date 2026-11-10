import type { Client } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";

export type DiagnosticsPhase =
  | "idle"
  | "steady"
  | "reconnect"
  | "slow_reader"
  | "churn"
  | "write_failure"
  | "pool_contention";

/** Fixed offered load with actual gRPC cancellation, reconnects and backpressured watches. */
export async function diagnosticsLoad<Measurement>(
  api: Client<typeof ui.GatewayService>,
  thread: string,
  phase: DiagnosticsPhase,
  duration: number,
  reconnect: () => Promise<object>,
  sample: () => Promise<object>,
  begin: () => Promise<Measurement>,
) {
  const latencies: number[] = [];
  const workload = { updates: 0, overviewReads: 0, detailReads: 0, reconnects: 0, openedWatches: 0 };
  const abort = new AbortController();
  const { watches, watchOpenP95Ms } = await warmWatches(api, thread, phase, abort.signal);
  workload.openedWatches += watches.length;
  const measurement = await begin();
  const until = performance.now() + duration;

  if (phase === "idle") {
    while (performance.now() < until) await Bun.sleep(Math.max(0, Math.min(1000, until - performance.now())));

    return { latencies, measurement, watchOpenP95Ms, ...workload };
  }

  let changes = 0;

  const extra = (async () => {
    let nextReconnect = performance.now() + 5000;
    let nextSample = performance.now() + 60_000;
    let nextOverview = performance.now();
    let nextDetails = performance.now();

    while (performance.now() < until) {
      const started = performance.now();

      if (process.env["CANOPY_BENCH_VIEW"] === "1" && performance.now() >= nextOverview) {
        await api.getDiagnostics({ windowMinutes: 15 });
        workload.overviewReads++;
        nextOverview = performance.now() + 5000;
      }

      if (process.env["CANOPY_BENCH_VIEW"] === "1" && performance.now() >= nextDetails) {
        await api.getComputerDiagnostics({ windowMinutes: 15, limit: 32, sortBy: "p95", callKind: "unary" });
        workload.detailReads++;
        nextDetails = performance.now() + 10_000;
      }

      if ((phase === "reconnect" || phase === "churn") && performance.now() >= nextReconnect) {
        await reconnect();
        workload.reconnects++;
        nextReconnect = performance.now() + 5000;
      }

      if (phase === "churn") {
        const cancel = new AbortController();
        const watch = api.watchOverview({}, { signal: cancel.signal })[Symbol.asyncIterator]();
        await watch.next();
        workload.openedWatches++;
        cancel.abort();
        await watch.return?.();

        if (performance.now() >= nextSample) {
          console.info(JSON.stringify({ phase: "churn_sample", ...(await sample()) }));
          nextSample = performance.now() + 60_000;
        }
      }

      await Bun.sleep(Math.max(0, 200 - (performance.now() - started)));
    }
  })();

  try {
    await Promise.all([
      extra,
      ...Array.from({ length: 4 }, async () => {
        while (performance.now() < until) {
          const start = performance.now();
          await api.getThread({ threadId: thread });
          latencies.push(performance.now() - start);
          await Bun.sleep(Math.max(0, 200 - (performance.now() - start)));
        }
      }),
      ...Array.from({ length: phase === "slow_reader" ? 4 : 0 }, async () => {
        while (performance.now() < until) {
          const start = performance.now();
          await api.updateThread({ threadId: thread, title: `Synthetic change ${++changes}` });
          workload.updates++;
          await Bun.sleep(Math.max(0, 200 - (performance.now() - start)));
        }
      }),
    ]);
  } finally {
    abort.abort();
    await Promise.all(watches.map((watch) => watch.return?.().catch(() => undefined)));
  }

  return { latencies, measurement, watchOpenP95Ms, ...workload };
}

/** Exclude initial transcript transfer and its warm-up from the steady offered-load interval. */
async function warmWatches(
  api: Client<typeof ui.GatewayService>,
  thread: string,
  phase: DiagnosticsPhase,
  signal: AbortSignal,
) {
  const watches =
    phase === "slow_reader"
      ? Array.from({ length: 8 }, () => api.watchThread({ threadId: thread }, { signal })[Symbol.asyncIterator]())
      : [];

  const opening: number[] = [];
  await Promise.all(
    watches.map(async (watch) => {
      const start = performance.now();
      await watch.next();
      opening.push(performance.now() - start);
    }),
  );
  opening.sort((a, b) => a - b);

  if (watches.length) await Bun.sleep(5000);

  return { watches, watchOpenP95Ms: opening[Math.max(0, Math.ceil(opening.length * 0.95) - 1)] ?? null };
}
