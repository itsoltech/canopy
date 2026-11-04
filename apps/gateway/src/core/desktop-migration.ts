import { createHash, randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { GatewayCore } from "./core.ts";
import { mobileGuard } from "./mobile-devices.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** One-time, explicitly authorized privilege migration for existing owned desktop workers only. */
export function desktopMigrationRoutes(core: GatewayCore, router: ConnectRouter, network: boolean) {
  const { runtime, userId } = core.mobile.options;

  const authenticate = (request: ui.DesktopMigrationRequest, context: HandlerContext) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(context.requestHeader.get("authorization") ?? "")?.[1] ?? "";

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql<{ id: string; name: string }>`SELECT id, name FROM workers
        WHERE id::text = ${request.workerId} AND credential_hash = ${digest(bearer)}
        AND owner_user_id = ${userId}::uuid AND revoked_at IS NULL AND archived_at IS NULL
        AND capabilities->'update'->>'installKind' = 'desktop' FOR UPDATE`;

      return rows[0];
    });
  };

  router.service(ui.DesktopMigrationService, {
    getDesktopMigrationRoutes: (request, context) =>
      mobileGuard(async () => {
        const worker = await runtime.runPromise(authenticate(request, context));

        if (!worker) throw new ConnectError("Owned desktop worker credential required", Code.Unauthenticated);
        const routes = core.mobile.networkRoutes();

        if (!routes.addresses.length)
          throw new ConnectError("Turn on Network access on the gateway to migrate this app", Code.FailedPrecondition);

        return routes;
      }),
    ...(network && {
      migrateDesktopClient: (request: ui.DesktopMigrationRequest, context: HandlerContext) =>
        mobileGuard(async () => {
          if (!["linux", "darwin", "win32"].includes(request.platform))
            throw new ConnectError("Unsupported desktop platform", Code.InvalidArgument);
          const token = `canopy_desktop_${randomBytes(32).toString("base64url")}`;

          const device = await runtime.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;

              return yield* sql.withTransaction(
                Effect.gen(function* () {
                  const worker = yield* authenticate(request, context);

                  if (!worker) return undefined;

                  const migrated =
                    yield* sql`SELECT worker_id FROM desktop_worker_migrations WHERE worker_id = ${worker.id}::uuid`;

                  if (migrated.length) return undefined;
                  const id = Bun.randomUUIDv7();
                  yield* sql`INSERT INTO mobile_devices (id, owner_user_id, name, platform, token_hash, pairing_version, client_kind)
              VALUES (${id}::uuid, ${userId}::uuid, ${worker.name}, ${request.platform}, ${digest(token)}, 2, 'desktop')`;
                  yield* sql`INSERT INTO desktop_worker_migrations (worker_id, device_id) VALUES (${worker.id}::uuid, ${id}::uuid)`;
                  yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details)
              VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, 'desktop.migrate', 'mobile_device', ${id}::uuid,
              ${JSON.stringify({ workerId: worker.id })}::jsonb)`;

                  return create(ui.MobileDeviceSchema, {
                    id,
                    name: worker.name,
                    platform: request.platform,
                    pairingVersion: 2,
                    clientKind: "desktop",
                    createdAt: timestampFromDate(new Date()),
                  });
                }),
              );
            }),
          );

          if (!device)
            throw new ConnectError(
              "Automatic migration unavailable. Pair this app in gateway Settings → Devices",
              Code.FailedPrecondition,
            );
          core.hub.publishOverview(
            create(ui.OverviewUpdateSchema, { change: { case: "mobileDevice", value: device } }),
          );

          return create(ui.ExchangeMobilePairingResponseSchema, {
            device,
            deviceToken: token,
            routes: core.mobile.networkRoutes(),
          });
        }),
    }),
  });
}
