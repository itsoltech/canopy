import type { ConnectRouter } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";

/** Both the deployment's server port and Network access must keep the frozen update service reachable. */
export function workerRoutes(core: GatewayCore, router: ConnectRouter) {
  core.link.routes(router);
  core.workers.routes(router);
  core.updates.service.routes(router);
}
