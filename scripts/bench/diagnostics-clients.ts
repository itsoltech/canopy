import { toJson } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { ClientMeasurements } from "@canopy/domain/diagnostics";
import type { Client, Transport } from "@connectrpc/connect";
import { gatewayDeadlines } from "../../apps/web/src/lib/server/gateway-deadlines.ts";
import { bffMeasurements, startBffDiagnostics } from "../../apps/web/src/lib/server/diagnostics.ts";
import { sseResponse } from "../../apps/web/src/lib/server/sse.ts";

const stage4 = process.env["CANOPY_BENCH_STAGE"] === "4";

/** The driver includes the real BFF wrappers. Its process resources are reported separately. */
export function clientTransport(transport: Transport) {
  return stage4 ? gatewayDeadlines(transport) : transport;
}

/** Fixed synthetic openings exercise numeric ingestion, not browser/native paint performance. */
export async function benchClients(api: Client<typeof ui.GatewayService>, enabled: boolean, signal: AbortSignal) {
  if (!stage4) return () => {};

  bffMeasurements.enabled = enabled;
  bffMeasurements.clear((await api.getComputerDiagnostics({})).epoch);
  startBffDiagnostics(api);
  const abort = new AbortController();
  const sources = ["web", "desktop", "mobile"] as const;
  const collectors = sources.map((source) => new ClientMeasurements(source, crypto.randomUUID()));
  const binding = crypto.randomUUID().replaceAll("-", "").padEnd(43, "x");
  let pending = false;

  const timer = setInterval(() => {
    if (!enabled || pending) return;
    pending = true;
    void (async () => {
      for (const collector of collectors) {
        // Twenty sampled openings per minute, bounded exactly like the client collector.
        for (let i = 0; i < 200; i++)
          if (collector.opening(Date.now(), () => (i % 10 === 0 ? 0 : 1))) {
            collector.record(i % 20 === 0 ? 0 : 1, 24);
            collector.record(2, 2);
          }

        const receipt = await api.submitDiagnostics(collector.take(), {
          signal: abort.signal,
          timeoutMs: 5000,
          headers: { "canopy-diagnostics-client": binding },
        });

        if (!receipt.accepted) collector.clear(receipt.epoch);
      }
    })()
      .catch(() => {})
      .finally(() => {
        pending = false;
      });
  }, 60_000);

  const stop = () => {
    clearInterval(timer);
    abort.abort();
    bffMeasurements.clear();
    signal.removeEventListener("abort", stop);
  };

  signal.addEventListener("abort", stop, { once: true });

  if (signal.aborted) stop();

  return stop;
}

/** Backpressure uses the same 1 MiB SSE buffer and cancellation as production. */
export async function* benchWatch(api: Client<typeof ui.GatewayService>, threadId: string, signal: AbortSignal) {
  if (!stage4) {
    yield* api.watchThread({ threadId }, { signal });

    return;
  }

  const response = sseResponse(
    new Request("http://localhost/bench", { signal }),
    (signal) => api.watchThread({ threadId }, { signal }),
    (value) => toJson(ui.ThreadUpdateSchema, value),
  );

  const reader = response.body!.getReader();

  try {
    for (;;) {
      const value = await reader.read();

      if (value.done) return;
      yield value.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
