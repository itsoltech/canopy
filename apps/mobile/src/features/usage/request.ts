import type { MessageInitShape } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError, type Client } from "@connectrpc/connect";

export type UsageReportResult = { status: "unavailable" } | { status: "ready"; data: ui.GetUsageStatsResponse };

export async function requestUsageReport(
  api: Client<typeof ui.GatewayService>,
  request: MessageInitShape<typeof ui.GetUsageStatsRequestSchema>,
  signal: AbortSignal,
): Promise<UsageReportResult> {
  const options = { signal, timeoutMs: 20_000 };

  try {
    const capabilities = await api.getClientCapabilities({}, options);
    signal.throwIfAborted();

    if (!capabilities.methods.includes(ui.GatewayService.method.getUsageStats.name)) return { status: "unavailable" };
    const data = await api.getUsageStats(request, options);
    signal.throwIfAborted();

    return { status: "ready", data };
  } catch (cause) {
    if (!signal.aborted && ConnectError.from(cause).code === Code.Unimplemented) return { status: "unavailable" };
    throw cause;
  }
}
