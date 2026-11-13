import type { Message } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { LinkedComputers } from "../computers/runtime.ts";
import type { Connection } from "../computers/runtime-context.ts";
import { linkedMessage } from "../computers/remote.ts";

export async function resetHomeDiagnostics(
  host: LinkedComputers,
  node: string,
  connection: Connection,
  request: Message,
) {
  if (
    !host.options.core ||
    host.relay.entries.has(node) ||
    !connection.capabilities?.has("diagnostics_v1") ||
    !host.hello().capabilities.includes("diagnostics_v1") ||
    !(await host.store.peer(node))
  )
    throw new ConnectError("Diagnostics control requires a supported direct link", Code.PermissionDenied);
  const input = linkedMessage(ui.ResetDiagnosticsRequestSchema, request);

  if (input.computerId !== host.hello().nodeId)
    throw new ConnectError("Diagnostics control cannot route onward", Code.PermissionDenied);

  try {
    return await host.options.core.diagnostics.actions.reset(input);
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    // Failed DB writes can carry bound parameters. The linked RPC boundary must never log the cause.
    throw new ConnectError("Could not reset counters; refresh diagnostics and retry", Code.Internal);
  }
}
