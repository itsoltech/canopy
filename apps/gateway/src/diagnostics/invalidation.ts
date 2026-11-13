import type { computerLink as link } from "@canopy/contracts";
import type { LinkedComputers } from "../computers/runtime.ts";
import { computersState } from "../computers/runtime-context.ts";

export function sendDiagnosticsInvalidation(
  host: LinkedComputers,
  destination: string,
  value: Pick<link.DiagnosticsInvalidated, "targetNodeId" | "homeNodeId">,
) {
  for (const connection of host[computersState].active.get(destination) ?? [])
    if (connection.ready && connection.capabilities?.has("diagnostics_v1"))
      connection.send({ body: { case: "diagnosticsInvalidated", value } });
}

/** Only an authenticated home or its known relay may invalidate that home's cache. */
export async function receiveDiagnosticsInvalidation(
  host: LinkedComputers,
  sender: string,
  value: link.DiagnosticsInvalidated,
) {
  if (value.targetNodeId === host.hello().nodeId) {
    const home = host.relay.entries.get(value.homeNodeId);

    if (home?.via_node_id !== sender || !["home", "both"].includes(home.relay_role)) return;
    await host.options.core?.diagnostics.peers.revoke(value.homeNodeId);
  } else if (value.homeNodeId === sender && host.relay.allowed(value.targetNodeId, sender)) {
    sendDiagnosticsInvalidation(host, value.targetNodeId, value);
  }
}
