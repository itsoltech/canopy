import type { GatewayCore } from "../core/core.ts";
import type { UiHandlers } from "./ui-service.ts";
import { mobileIdentity } from "../core/mobile-devices.ts";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";

/** Source registration is a private service-token channel. A paired renderer/phone cannot register paths or sources. */
export function requireLocalLogSource(context: HandlerContext) {
  if (context.values.get(mobileIdentity) || context.protocolName === "canopy.link")
    throw new ConnectError("Log sources require the private local service channel", Code.PermissionDenied);
}

async function logsGuard<A>(run: () => Promise<A>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    throw new ConnectError("Could not collect logs. Retry with a smaller selection.", Code.Internal);
  }
}

export function diagnosticsLogHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "collectDiagnosticsLogs"
  | "getDiagnosticsLogsJob"
  | "cancelDiagnosticsLogs"
  | "downloadDiagnosticsLogs"
  | "watchDiagnosticsLogSource"
  | "replyDiagnosticsLogSource"
> {
  return {
    collectDiagnosticsLogs: (request, context) =>
      logsGuard(() => core.diagnostics.logs.collect(request, context.values.get(mobileIdentity)?.deviceId)),
    getDiagnosticsLogsJob: (request) => core.diagnostics.logs.get(request.jobId),
    cancelDiagnosticsLogs: (request) => logsGuard(() => core.diagnostics.logs.cancel(request.jobId)),
    downloadDiagnosticsLogs: (request, context) => core.diagnostics.logs.download(request.jobId, context.signal),
    watchDiagnosticsLogSource: (request, context) => {
      requireLocalLogSource(context);

      return core.diagnostics.logs.home.registered.watch(request, context.signal);
    },
    replyDiagnosticsLogSource: (request, context) => {
      requireLocalLogSource(context);

      return core.diagnostics.logs.home.registered.reply(request);
    },
  };
}
