import { Code, ConnectError } from "@connectrpc/connect";
import { type GatewayCore } from "../core/core.ts";
import type { UiHandlers } from "./ui-service.ts";

function network(core: GatewayCore) {
  if (!core.network) throw new ConnectError("Network access is not initialized", Code.FailedPrecondition);

  return core.network;
}

export function networkHandlers(core: GatewayCore): Pick<UiHandlers, "getNetworkAccess" | "updateNetworkAccess"> {
  return {
    getNetworkAccess: async () => network(core).status(),
    updateNetworkAccess: (r) => network(core).update(r),
  };
}
