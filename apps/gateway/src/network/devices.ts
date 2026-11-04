import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { serviceTokenAuth, uiRoutes } from "../api/index.ts";
import type { GatewayCore } from "../core/core.ts";
import type { Handler } from "./listener.ts";
import type { NetworkAccess } from "./network.ts";
import { offerWorkerRoutes } from "./workers.ts";
import { workerRoutes } from "../worker-link/routes.ts";

/** Native RPCs only: reject browser origins and authenticate every service at its boundary. */
export function mountMobileNetwork(core: GatewayCore, network: NetworkAccess, serviceToken: string) {
  const adapter = connectNodeAdapter({
    routes: (router) => {
      core.mobile.routes(router);
      uiRoutes(core)(router);
    },
    interceptors: [serviceTokenAuth(serviceToken, core.mobile)],
    readMaxBytes: 32 * 1024 * 1024,
  });

  const workers = connectNodeAdapter({
    routes: (router) => workerRoutes(core, router, true),
    readMaxBytes: 32 * 1024 * 1024,
  });

  const handler: Handler = (request, response) => {
    response.setHeader("cache-control", "no-store");

    if (request.headers.origin) {
      response.writeHead(403);
      response.end();

      return;
    }

    const path = request.url?.split("?")[0] ?? "";

    if (
      path.startsWith("/canopy.worker.v1.") ||
      path.startsWith("/canopy.update.v1.") ||
      path.startsWith("/canopy.ui.v1.DesktopMigrationService/")
    )
      return workers(request, response);

    return adapter(request, response);
  };

  network.mount("device", handler);

  return network.onChange(() => {
    for (const connection of core.link.connections.values()) offerWorkerRoutes(core, connection);
    core.hub.publishOverview(
      create(ui.OverviewUpdateSchema, {
        change: { case: "mobileRoutes", value: core.mobile.networkRoutes() },
      }),
    );
  });
}
