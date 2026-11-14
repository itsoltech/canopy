import { Code, ConnectError } from "@connectrpc/connect";
import type { NetworkAccess } from "../network/network.ts";
import type { GatewayRole } from "../role.ts";
import { occupiedTarget } from "./empty-target.ts";
import type { MigrationStore } from "./store.ts";
import { localVersions, type Versions } from "./versions.ts";

export const TARGET_NOT_EMPTY = "Target has existing data. Choose an empty server.";

/** What both sides of a migration share: the owner's store, this gateway's role, versions and identity. */
export class MigrationContext {
  constructor(
    readonly store: MigrationStore,
    readonly role: GatewayRole,
    readonly network: () => NetworkAccess | undefined,
    readonly build: string,
  ) {}

  async versions(): Promise<Versions> {
    return localVersions(this.build, await this.store.schemaVersion());
  }

  /** The server side runs only on a server, the source side only in the desktop app's local gateway. */
  requireRole(role: GatewayRole) {
    if (this.role !== role)
      throw new ConnectError(
        role === "server"
          ? "Import from desktop is available only on a Canopy server."
          : "Moving to a server starts in the Canopy desktop app.",
        Code.FailedPrecondition,
      );
  }

  /** §3: only the bootstrap of a new server may exist before an import. Never deleted automatically. */
  async requireEmptyTarget() {
    if ((await occupiedTarget(this.store)).length) throw new ConnectError(TARGET_NOT_EMPTY, Code.FailedPrecondition);
  }
}
