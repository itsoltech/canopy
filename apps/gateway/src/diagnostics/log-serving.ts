import type { Message } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { LinkedComputers } from "../computers/runtime.ts";
import type { Connection } from "../computers/runtime-context.ts";
import { linkedMessage } from "../computers/remote.ts";
import { DIAGNOSTICS_LOGS } from "../computers/capabilities.ts";

/** Only this home exports; no computer IDs or recursive gather exist in the internal contract. */
export async function* serveHomeLogs(
  host: LinkedComputers,
  origin: string,
  connection: Connection,
  message: Message,
  signal: AbortSignal,
) {
  const logs = host.options.core?.diagnostics.logs;

  if (
    !logs?.enabled ||
    !host.hello().capabilities.includes(DIAGNOSTICS_LOGS) ||
    !connection.capabilities?.has(DIAGNOSTICS_LOGS)
  )
    throw new ConnectError("Update to collect logs", Code.Unimplemented);
  const relay = host.relay.entries.get(origin);

  if (
    relay &&
    !(
      await host.store.query(
        "SELECT 1 FROM diagnostics_log_grants WHERE owner_user_id=$1::uuid AND origin_computer_id=$2 AND via_node_id=$3",
        [host.store.owner, origin, relay.via_node_id],
      )
    ).length
  )
    throw new ConnectError("Logs are not shared with this computer", Code.PermissionDenied);
  await logs.initialise();
  yield* logs.home.stream(linkedMessage(ui.DiagnosticsHomeLogsRequestSchema, message), origin, signal);
}
