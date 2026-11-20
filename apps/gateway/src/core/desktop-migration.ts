import { createHash } from "node:crypto";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { SqlClient } from "effect/sql";
import type { GatewayCore } from "./core.ts";
import { mobileGuard } from "./mobile-devices.ts";

/** Older desktops can discover routes and fall back to owner-authorized pairing. */
export function desktopMigrationRoutes(core: GatewayCore, router: ConnectRouter, network: boolean) {
  const { runtime, userId } = core.mobile.options;

  router.service(ui.DesktopMigrationService, {
    getDesktopMigrationRoutes: (request, context) =>
      mobileGuard(async () => {
        const bearer = /^Bearer\s+(\S+)$/i.exec(context.requestHeader.get("authorization") ?? "")?.[1] ?? "";
        const hash = createHash("sha256").update(bearer).digest("hex");

        const workers = await runtime.runPromise(
          SqlClient.SqlClient.use(
            (sql) => sql`SELECT id FROM workers
            WHERE id::text = ${request.workerId} AND credential_hash = ${hash}
            AND owner_user_id = ${userId}::uuid AND revoked_at IS NULL AND archived_at IS NULL
            AND capabilities->'update'->>'installKind' = 'desktop'`,
          ),
        );

        if (!workers.length) throw new ConnectError("Owned desktop worker credential required", Code.Unauthenticated);
        const routes = core.mobile.networkRoutes();

        if (!routes.addresses.length)
          throw new ConnectError("Turn on Network access on the gateway to pair this app", Code.FailedPrecondition);

        return routes;
      }),
    ...(network && {
      migrateDesktopClient: () => {
        throw new ConnectError(
          "Automatic migration unavailable. Pair this app in gateway Settings → Devices",
          Code.FailedPrecondition,
        );
      },
    }),
  });
}
