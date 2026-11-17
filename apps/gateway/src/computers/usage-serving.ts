import type { DescMethod, Message } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { exportUsageBuckets } from "../usage/export.ts";
import { USAGE_STATS } from "./capabilities.ts";
import { linkedMessage } from "./remote-policy.ts";
import type { Connection } from "./runtime-context.ts";
import type { LinkedComputers } from "./runtime.ts";

/** Only the mutually authenticated direct peer may read this owner's local ledger. */
export async function serveUsageBuckets(
  host: LinkedComputers,
  node: string,
  connection: Connection,
  method: DescMethod,
  request: Message,
) {
  if (method.name !== "GetUsageBuckets" || method.parent.typeName !== link.UsageService.typeName)
    throw new ConnectError("Unknown usage action", Code.Unimplemented);

  if (
    !host.hello().capabilities.includes(USAGE_STATS) ||
    !connection.capabilities?.has(USAGE_STATS) ||
    host.relay.entries.has(node) ||
    !(await host.store.peer(node))
  )
    throw new ConnectError("Usage statistics require a linked computer with support", Code.PermissionDenied);

  return exportUsageBuckets(host.store, linkedMessage(link.UsageBucketsRequestSchema, request));
}
