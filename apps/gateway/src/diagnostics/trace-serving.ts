import type { Message } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { LinkedComputers } from "../computers/runtime.ts";
import type { Connection } from "../computers/runtime-context.ts";
import { linkedMessage } from "../computers/remote.ts";
import { DIAGNOSTICS_TRACE } from "../computers/capabilities.ts";

/** Direct owner peers already have explicit log-export permission; onward callers never reach this action. */
export async function serveHomeTrace(
  host: LinkedComputers,
  origin: string,
  connection: Connection,
  message: Message,
  exporting: boolean,
) {
  if (
    !host.options.core ||
    host.relay.entries.has(origin) ||
    !(await host.store.peer(origin)) ||
    !connection.capabilities?.has(DIAGNOSTICS_TRACE) ||
    !host.hello().capabilities.includes(DIAGNOSTICS_TRACE)
  )
    throw new ConnectError("Tracing requires a supported direct computer", Code.PermissionDenied);
  const request = linkedMessage(ui.DiagnosticsTraceRequestSchema, message);

  if (request.computerId !== host.hello().nodeId)
    throw new ConnectError("Tracing cannot route onward", Code.PermissionDenied);

  try {
    const value = await host.options.core.diagnostics.tracing.action(request, exporting, origin);

    return exporting ? value : value.state!;
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    throw new ConnectError("Could not complete tracing. Refresh diagnostics and retry.", Code.Internal);
  }
}
