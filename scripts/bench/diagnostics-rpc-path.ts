import { createClient, createRouterTransport } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { heapStats, profile } from "bun:jsc";
import { RpcCollector } from "../../apps/gateway/src/diagnostics/collector.ts";
import { diagnosticsInterceptor } from "../../apps/gateway/src/diagnostics/interceptor.ts";
import { registered } from "../../apps/gateway/src/diagnostics/registry.ts";
import { DatabaseMonitor } from "../../apps/gateway/src/diagnostics/database.ts";
import { rpcContext } from "../../apps/gateway/src/diagnostics/query-context.ts";

/** Same Stage 1 interceptor in both members; isolate clocks, descriptor/maps, buckets and SQL completion. */
async function member(on: boolean) {
  const method = registered(ui.GatewayService.method.getThread);
  const collector = new RpcCollector([method]);
  collector.gatewayEnabled = on;
  const monitor = new DatabaseMonitor();
  monitor.collector = collector;

  const api = createClient(
    ui.GatewayService,
    createRouterTransport(
      (router) =>
        router.rpc(ui.GatewayService.method.getThread, () => {
          if (on) {
            const rpc = rpcContext.getStore() ?? 0;

            for (const phase of ["reserve", "execute", "release"] as const)
              monitor.record("thread.page", phase, performance.now(), false, rpc);
          }

          return {};
        }),
      { router: { interceptors: [diagnosticsInterceptor(collector)] } },
    ),
  );

  const batches: number[] = [];

  for (let batch = 0; batch < 120; batch++) {
    const start = performance.now();

    for (let request = 0; request < 256; request++) await api.getThread({ threadId: "synthetic" });
    collector.flushDatabase();

    if (batch >= 20) batches.push((performance.now() - start) / 256);
  }

  batches.sort((a, b) => a - b);

  return {
    on,
    calls: 25600,
    medianMs: batches[50],
    p95Ms: batches[94],
    collectorBytes: collector.budget.used,
    dropped: collector.budget.dropped,
    heapBytes: heapStats().heapSize,
  };
}

for (let pair = 1; pair <= 4; pair++) {
  for (const on of pair % 2 ? [false, true] : [true, false]) {
    Bun.gc(true);
    const result = await member(on);
    console.info(JSON.stringify({ pair, ...result }));
  }
}

const output = process.env["CANOPY_BENCH_RPC_PROFILE"];

if (output) {
  const sampled = await profile(async () => {
    await member(true);
  }, 1000);

  await Bun.write(output, JSON.stringify(sampled), { mode: 0o600 });
}
