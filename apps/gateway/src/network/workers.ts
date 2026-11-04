import type { GatewayCore } from "../core/core.ts";
import type { WorkerConnection } from "../worker-link/index.ts";

/** Additive, authenticated advice: an unreachable Network access route never retires the server port. */
export function offerWorkerRoutes(core: GatewayCore, connection: WorkerConnection) {
  if (!connection.isOpen || !connection.hello.capabilities.includes("network_route_migration")) return;

  connection.send({
    case: "networkRoutes",
    value: { origins: core.network?.origins() ?? [], fingerprint: core.network?.fingerprint ?? "" },
  });
}
