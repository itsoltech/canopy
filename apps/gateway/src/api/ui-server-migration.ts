import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import { mobileIdentity } from "../core/mobile-devices.ts";
import type { UiHandlers } from "./ui-service.ts";

/** Only the owner's trusted UI prepares or approves a move: the web BFF or a paired desktop client.
 * Phones can't (docs/desktop-server-migration.md §5); workers and models have no UI credential. */
function owner(core: GatewayCore, context: HandlerContext) {
  const device = context.values.get(mobileIdentity);

  if (device && device.clientKind !== "desktop")
    throw new ConnectError("Move to a server from a computer, not a phone.", Code.PermissionDenied);

  // Device tokens are already owner-bound; the migration never acts for another owner's device.
  if (device && device.userId !== core.serverMigration.store.owner)
    throw new ConnectError("Migration not found", Code.NotFound);
}

export function serverMigrationHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "getServerMigration"
  | "createServerMigrationInvitation"
  | "pairServerMigration"
  | "confirmServerMigrationPeer"
  | "negotiateServerMigration"
  | "revokeServerMigration"
> {
  const migrations = () => core.serverMigration;

  return {
    getServerMigration: async (_r, context) => {
      owner(core, context);

      return migrations().snapshot();
    },
    createServerMigrationInvitation: async (_r, context) => {
      owner(core, context);

      return migrations().target.invite();
    },
    pairServerMigration: async (r, context) => {
      owner(core, context);
      await migrations().source.pair(r.invitation);

      return migrations().snapshot();
    },
    confirmServerMigrationPeer: async (r, context) => {
      owner(core, context);

      if (core.role === "server") await migrations().target.confirm(r.sessionId, r.sourceId, r.fingerprint);
      else await migrations().source.confirm(r.sessionId, r.fingerprint);

      return migrations().snapshot();
    },
    negotiateServerMigration: async (r, context) => {
      owner(core, context);
      await migrations().source.negotiate(r.sessionId);

      return migrations().snapshot();
    },
    revokeServerMigration: async (r, context) => {
      owner(core, context);

      if (core.role === "server") await migrations().target.revoke(r.sessionId, r.sourceId);
      else await migrations().source.revoke(r.sessionId);

      return migrations().snapshot();
    },
  };
}
