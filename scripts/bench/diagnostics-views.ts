import { ui } from "@canopy/contracts";
import { DATABASE_FAMILIES, DATABASE_PHASES, databaseMetric } from "@canopy/domain/diagnostics";
import { RpcCollector } from "../../apps/gateway/src/diagnostics/collector.ts";
import { registered } from "../../apps/gateway/src/diagnostics/registry.ts";
import { rpcSnapshot } from "../../apps/gateway/src/diagnostics/snapshot.ts";

/** Same populated rings, with/without SQL detail: overview must not aggregate discarded data. */
export function benchmarkDiagnosticsViews() {
  const method = registered(ui.GatewayService.method.getThread);
  let now = 0;
  const collector = new RpcCollector([method], { monotonic: () => now, utc: () => now });

  for (let minute = 0; minute < 15; minute++) {
    now = minute * 60_000;
    collector.measure(2, 5, false, 0, 5000);

    for (const family of DATABASE_FAMILIES.slice(1, 13))
      for (const phase of DATABASE_PHASES)
        collector.measure(databaseMetric(family.name, phase), 0.25, false, method.id);
  }

  for (let pair = 1; pair <= 3; pair++)
    for (const overviewOnly of pair % 2 ? [false, true] : [true, false]) {
      Bun.gc(true);
      const times: number[] = [];
      let familyRows = 0;

      for (let sample = 0; sample < 550; sample++) {
        const start = performance.now();
        const value = rpcSnapshot(collector, 15, undefined, overviewOnly);

        if (sample >= 50) {
          times.push(performance.now() - start);
          familyRows += value.database.length;
        }
      }

      times.sort((a, b) => a - b);
      console.info(
        JSON.stringify({
          pair,
          mode: overviewOnly ? "overview" : "detail",
          medianMs: times[250],
          p95Ms: times[474],
          views: times.length,
          familyRows,
          collectorBytes: collector.budget.used,
          transientBytesAfterView: collector.windowBudget.used,
          dropped: collector.budget.dropped,
        }),
      );
    }
}
