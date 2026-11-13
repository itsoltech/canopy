import type { Client } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";

/** A=inactive and B=explicit opt-in, with stages 1–5 enabled on both fresh sides. */
export async function benchTracing(api: Client<typeof ui.GatewayService>, phase: string, duration: number) {
  if (
    process.env["CANOPY_BENCH_STAGE"] !== "6" ||
    process.env["CANOPY_BENCH_MEMBER"] !== "B" ||
    process.env["CANOPY_BENCH_CONTROL"] === "1"
  )
    return async () => {};

  const computer = await api.getComputerDiagnostics({ computerId: "local", windowMinutes: 1 });
  const worker = computer.links.find((link) => link.kind === "worker" && link.online);

  if (phase === "trace_worker" && !worker) throw new Error("Tracing benchmark requires its worker");
  const processId = phase === "trace_worker" ? `worker:${worker!.targetId}` : "gateway";

  const state = await api.controlDiagnosticsTrace({
    computerId: "local",
    processId,
    action: "start",
    minutes: duration > 60000 ? 5 : 1,
  });

  if (!state.active) throw new Error("Tracing did not activate");

  return async () => {
    const request = { computerId: "local", processId, leaseId: state.leaseId };
    const exported = await api.exportDiagnosticsTrace(request);

    if (phase !== "idle" && !exported.spans.length) throw new Error("Active tracing workload produced no samples");
    console.info(
      JSON.stringify({
        phase: "trace_action",
        workload: phase,
        samples: exported.spans.length,
        dropped: String(exported.droppedSamples),
        process: phase === "trace_worker" ? "worker" : "gateway",
      }),
    );
    await api.controlDiagnosticsTrace({ ...request, action: "stop" });
  };
}
