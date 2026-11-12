import type { Client } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";

export type DiagnosticsPhase =
  | "idle"
  | "steady"
  | "reconnect"
  | "slow_reader"
  | "churn"
  | "write_failure"
  | "pool_contention"
  | "governor";

/** Fixed offered load with actual gRPC cancellation, reconnects and backpressured watches. */
export async function diagnosticsLoad<Measurement>(
  api: Client<typeof ui.GatewayService>,
  thread: string,
  phase: DiagnosticsPhase,
  duration: number,
  reconnect: () => Promise<object>,
  sample: () => Promise<object>,
  begin: () => Promise<Measurement>,
  signal?: AbortSignal,
) {
  const latencies: number[] = [];
  const workload = { updates: 0, overviewReads: 0, detailReads: 0, reconnects: 0, openedWatches: 0 };
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const { watches, watchOpenP95Ms } = await warmWatches(api, thread, phase, abort.signal);
  workload.openedWatches += watches.length;
  const measurement = await begin();
  const until = performance.now() + duration;

  if (phase === "idle") {
    while (performance.now() < until && !signal?.aborted)
      await Bun.sleep(Math.max(0, Math.min(1000, until - performance.now())));
    signal?.removeEventListener("abort", cancel);

    return { latencies, measurement, watchOpenP95Ms, ...workload };
  }

  let changes = 0;
  const historyReads: number[] = [];

  const extra = (async () => {
    let nextReconnect = performance.now() + 5000;
    let nextSample = performance.now() + 60_000;
    let nextOverview = performance.now();
    let nextDetails = performance.now();

    while (performance.now() < until && !signal?.aborted) {
      const started = performance.now();

      if (process.env["CANOPY_BENCH_VIEW"] === "1" && performance.now() >= nextOverview) {
        if (process.env["CANOPY_BENCH_SOURCE_ROOT"]) await api.listThreads({ sidebarOnly: true });
        else await api.getDiagnostics({ windowMinutes: 15 });
        workload.overviewReads++;
        nextOverview = performance.now() + 5000;
      }

      if (process.env["CANOPY_BENCH_VIEW"] === "1" && performance.now() >= nextDetails) {
        const start = performance.now();

        if (process.env["CANOPY_BENCH_SOURCE_ROOT"]) await api.listThreads({ sidebarOnly: true });
        else await api.getComputerDiagnostics({ windowMinutes: 1440, limit: 32, sortBy: "p95", callKind: "unary" });
        const elapsedMs = performance.now() - start;
        historyReads.push(elapsedMs);
        console.info(
          JSON.stringify({
            phase: "history_read",
            workload: phase,
            atMs: Date.now(),
            elapsedMs,
            completed: true,
            probe: process.env["CANOPY_BENCH_SOURCE_ROOT"] ? "dev_thread_list_sql" : "diagnostics_history",
          }),
        );
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
        while (performance.now() < until && !signal?.aborted) {
          const start = performance.now();
          await api.getThread({ threadId: thread });
          latencies.push(performance.now() - start);
          await Bun.sleep(Math.max(0, 200 - (performance.now() - start)));
        }
      }),
      ...Array.from({ length: phase === "slow_reader" ? 4 : 0 }, async () => {
        while (performance.now() < until && !signal?.aborted) {
          const start = performance.now();
          await api.updateThread({ threadId: thread, title: `Synthetic change ${++changes}` });
          workload.updates++;
          await Bun.sleep(Math.max(0, 200 - (performance.now() - start)));
        }
      }),
    ]);
  } finally {
    signal?.removeEventListener("abort", cancel);
    abort.abort();
    await Promise.all(watches.map((watch) => watch.return?.().catch(() => undefined)));
  }

  historyReads.sort((a, b) => a - b);

  return {
    latencies,
    measurement,
    watchOpenP95Ms,
    historyReadP95Ms: historyReads[Math.max(0, Math.ceil(historyReads.length * 0.95) - 1)] ?? null,
    ...workload,
  };
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
