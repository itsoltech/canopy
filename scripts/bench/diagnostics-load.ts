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
export async function diagnosticsLoad(
  api: Client<typeof ui.GatewayService>,
  thread: string,
  phase: DiagnosticsPhase,
  duration: number,
  reconnect: () => Promise<object>,
  sample: () => Promise<object>,
) {
  const latencies: number[] = [];
  const workload = { updates: 0, overviewReads: 0, detailReads: 0, reconnects: 0, openedWatches: 0 };
  const until = performance.now() + duration;

  if (phase === "idle") {
    while (performance.now() < until) await Bun.sleep(Math.max(0, Math.min(1000, until - performance.now())));

    return { latencies, ...workload };
  }

  const abort = new AbortController();

  const watches =
    phase === "slow_reader"
      ? Array.from({ length: 8 }, () =>
          api.watchThread({ threadId: thread }, { signal: abort.signal })[Symbol.asyncIterator](),
        )
      : [];

  await Promise.all(watches.map((watch) => watch.next()));
  workload.openedWatches += watches.length;

  const extra = (async () => {
    let nextReconnect = performance.now() + 5000;
    let nextSample = performance.now() + 60_000;
    let nextOverview = performance.now();
    let nextDetails = performance.now();
    let changes = 0;

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

      if (phase === "slow_reader") {
        await api.updateThread({ threadId: thread, title: `Synthetic change ${++changes}` });
        workload.updates++;
      }

      await Bun.sleep(Math.max(0, (phase === "slow_reader" ? 50 : 200) - (performance.now() - started)));
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
    ]);
  } finally {
    abort.abort();
    await Promise.all(watches.map((watch) => watch.return?.().catch(() => undefined)));
  }

  return { latencies, ...workload };
}
