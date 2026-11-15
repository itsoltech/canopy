import { create } from "@bufbuild/protobuf";
import type { Http2ServerRequest } from "node:http2";
import { TLSSocket } from "node:tls";
import { serverMigration, ui } from "@canopy/contracts";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { serviceTokenAuth, uiRoutes } from "../api/index.ts";
import type { GatewayCore } from "../core/core.ts";
import type { Handler } from "./listener.ts";
import type { NetworkAccess } from "./network.ts";
import { offerWorkerRoutes } from "./workers.ts";
import { workerRoutes } from "../worker-link/routes.ts";

const MIGRATION_PAIRING = `/${serverMigration.MigrationPairingService.typeName}/`;

const modernTls = (request: Http2ServerRequest) =>
  request.httpVersionMajor === 2 && request.socket instanceof TLSSocket && request.socket.getProtocol() === "TLSv1.3";

/** Native RPCs only: reject browser origins and authenticate every service at its boundary. */
export function mountMobileNetwork(core: GatewayCore, network: NetworkAccess, serviceToken: string) {
  const adapter = connectNodeAdapter({
    routes: (router) => {
      core.mobile.routes(router);
      core.desktopControl.routes(router);

      // Desktop → server migration pairing: public like the other exchanges, only on a server.
      if (core.role === "server") core.serverMigration.pairingRoutes(router);
      uiRoutes(core)(router);
    },
    interceptors: [core.diagnostics.interceptor, serviceTokenAuth(serviceToken, core.mobile)],
    readMaxBytes: 32 * 1024 * 1024,
  });

  const workers = connectNodeAdapter({
    interceptors: [core.diagnostics.interceptor],
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

    // Migration pairing carries a one-time code: HTTP/2 over TLS 1.3 only. Phones elsewhere may use TLS 1.2.
    if (path.startsWith(MIGRATION_PAIRING) && !modernTls(request)) {
      response.writeHead(403);
      response.end();

      return;
    }

    if (
      path.startsWith("/canopy.worker.v1.") ||
      path.startsWith("/canopy.update.v1.") ||
      path.startsWith("/canopy.ui.v1.DesktopMigrationService/")
    )
      return workers(request, response);

    return adapter(request, response);
  };

  network.mount("device", handler);

  if (core.role === "server") network.mount("migration", core.serverMigration.handler());

  return network.onChange(() => {
    for (const connection of core.link.connections.values()) offerWorkerRoutes(core, connection);
    core.hub.publishOverview(
      create(ui.OverviewUpdateSchema, {
        change: { case: "mobileRoutes", value: core.mobile.networkRoutes() },
      }),
    );
  });
}
