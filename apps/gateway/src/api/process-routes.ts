import type { ConnectRouter } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import { workerRoutes } from "../worker-link/routes.ts";
import { serviceTokenAuth } from "./auth.ts";
import { uiRoutes } from "./ui-service.ts";

/** The process listener serves the private BFF. Device bearer tokens are scoped to Network access. */
export function gatewayProcessApi(core: GatewayCore, token: string, web?: (version: string) => void) {
  return {
    routes: (router: ConnectRouter) => {
      workerRoutes(core, router);
      uiRoutes(core)(router);
    },
    auth: serviceTokenAuth(token, undefined, web),
  };
}
