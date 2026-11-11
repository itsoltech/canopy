import { ui } from "@canopy/contracts";
import { databaseMetric, type DatabasePhase } from "@canopy/domain/diagnostics";
import { RpcCollector } from "../../apps/gateway/src/diagnostics/collector.ts";
import { registered } from "../../apps/gateway/src/diagnostics/registry.ts";

const method = registered(ui.GatewayService.method.getThread);
const phases = ["reserve", "execute", "release"] as const;
const batches = 1000;
const queries = 256;

/** Isolate completion-hook work from network/DB scheduling; identical samples and drains.
 * The synchronous case preserves the original Stage 2 recorder for a same-process comparison.
 */
function run(deferred: boolean) {
  const collector = new RpcCollector([method]);
  const samples: number[] = [];
  let drainMs = 0;

  const record = (phase: DatabasePhase) => {
    const now = performance.now();
    const id = databaseMetric("thread.page", phase);

    if (deferred) collector.recordDatabase(id, 0.25, false, method.id, now);
    else {
      collector.measure(id, 0.25, false, method.id);

      if (phase === "execute") collector.measure(11, 1);

      if (phase === "reserve") collector.measure(12, 0.25);
    }
  };

  for (let batch = 0; batch < batches + 100; batch++) {
    const start = performance.now();

    for (let query = 0; query < queries; query++) for (const phase of phases) record(phase);
    const hotMs = performance.now() - start;
    const draining = performance.now();
    collector.flushDatabase();

    if (batch >= 100) {
      samples.push(hotMs / queries);
      drainMs += performance.now() - draining;
    }
  }

  samples.sort((a, b) => a - b);

  return {
    mode: deferred ? "deferred" : "synchronous",
    queries: batches * queries,
    batchQueries: queries,
    hotMedianMicros: samples[Math.floor(samples.length / 2)]! * 1000,
    hotP95Micros: samples[Math.ceil(samples.length * 0.95) - 1]! * 1000,
    drainMicrosPerQuery: (drainMs * 1000) / (batches * queries),
    budgetBytes: collector.budget.used,
    dropped: collector.budget.dropped,
  };
}

for (let pair = 1; pair <= 3; pair++)
  for (const deferred of pair % 2 ? [false, true] : [true, false]) {
    Bun.gc(true);
    console.info(JSON.stringify({ pair, ...run(deferred) }));
  }
