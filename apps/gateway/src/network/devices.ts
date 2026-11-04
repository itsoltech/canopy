import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { serviceTokenAuth, uiRoutes } from "../api/index.ts";
import type { GatewayCore } from "../core/core.ts";
import type { Handler } from "./listener.ts";
import type { NetworkAccess } from "./network.ts";

/** Native Connect only: never expose browser CORS, BFF credentials, worker RPCs or the database. */
export function mountMobileNetwork(core: GatewayCore, network: NetworkAccess, serviceToken: string) {
  const adapter = connectNodeAdapter({
    routes: (router) => {
      core.mobile.routes(router);
      uiRoutes(core)(router);
    },
    grpc: false,
    interceptors: [serviceTokenAuth(serviceToken, core.mobile)],
    readMaxBytes: 32 * 1024 * 1024,
  });

  const handler: Handler = (request, response) => {
    response.setHeader("cache-control", "no-store");

    if (request.headers.origin) {
      response.writeHead(403);
      response.end();

      return;
    }

    return adapter(request, response);
  };

  network.mount("device", handler);

  return network.onChange(() =>
    core.hub.publishOverview(
      create(ui.OverviewUpdateSchema, {
        change: { case: "mobileRoutes", value: core.mobile.networkRoutes() },
      }),
    ),
  );
}
