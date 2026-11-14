import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { serverMigration as migration, ui } from "@canopy/contracts";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import type { CoreRuntime } from "../core/core.ts";
import type { NetworkAccess } from "../network/network.ts";
import type { GatewayRole } from "../role.ts";
import { migrationHandler, migrationPeer } from "./channel.ts";
import { MigrationContext } from "./context.ts";
import { MigrationSource } from "./source.ts";
import { MigrationStore, type SessionRow, type SourceRow, type TargetRow } from "./store.ts";
import { MigrationTarget } from "./target.ts";

export type ServerMigrationOptions = {
  runtime: CoreRuntime;
  owner: string;
  role: GatewayRole;
  network: () => NetworkAccess | undefined;
  /** This gateway's build; the release version by default. */
  build?: string;
};

const sourcePeer = (row: SourceRow) =>
  create(ui.ServerMigrationPeerSchema, {
    id: row.id,
    nodeId: row.source_node_id ?? "",
    name: row.source_name,
    fingerprint: row.certificate_pin ?? "",
    paired: Boolean(row.exchanged_at),
    confirmed: Boolean(row.confirmed_at),
    negotiated: Boolean(row.negotiated_at),
    revoked: Boolean(row.revoked_at),
    build: row.source_build,
    schema: row.source_schema,
    expiresAt: timestampFromDate(row.credential_expires_at ?? row.invitation_expires_at),
  });

const targetPeer = (row: TargetRow) =>
  create(ui.ServerMigrationPeerSchema, {
    nodeId: row.target_node_id,
    name: row.target_name,
    fingerprint: row.target_fingerprint,
    paired: Boolean(row.exchanged_at),
    confirmed: Boolean(row.confirmed_at),
    negotiated: Boolean(row.negotiated_at),
    revoked: Boolean(row.revoked_at),
    build: row.target_build,
    schema: row.target_schema,
    expiresAt: timestampFromDate(row.credential_expires_at),
  });

const sessionView = (row: SessionRow, peers: ui.ServerMigrationPeer[]) =>
  create(ui.ServerMigrationSessionSchema, {
    id: row.id,
    role: row.role,
    state: row.state,
    generation: row.generation,
    build: row.build_version,
    schema: row.schema_version,
    protocol: row.protocol,
    peers,
    createdAt: timestampFromDate(row.created_at),
  });

/** Desktop → server migration sessions of this gateway's owner (docs/desktop-server-migration.md). Stage 1:
 * pairing, mutual TLS, version negotiation and the empty-target reservation; no data moves yet. */
export class ServerMigrations {
  readonly store: MigrationStore;
  readonly target: MigrationTarget;
  readonly source: MigrationSource;

  constructor(options: ServerMigrationOptions) {
    this.store = new MigrationStore(options.runtime, options.owner);
    const context = new MigrationContext(this.store, options.role, options.network, options.build ?? CANOPY_VERSION);
    this.target = new MigrationTarget(context);
    this.source = new MigrationSource(context);
  }

  /** The owner's open session on this gateway, either side. */
  async snapshot() {
    await this.store.closeUnpairedTarget();
    const target = await this.store.openSession("target");

    if (target)
      return create(ui.ServerMigrationSnapshotSchema, {
        session: sessionView(target, (await this.store.sources(target.id)).map(sourcePeer)),
      });
    const source = await this.store.openSession("source");
    const row = source && (await this.store.target(source.id));

    return create(ui.ServerMigrationSnapshotSchema, {
      ...(source && row && { session: sessionView(source, [targetPeer(row)]) }),
    });
  }

  /** The public pairing exchange, on the server's Network access listener only. */
  pairingRoutes(router: ConnectRouter) {
    router.service(migration.MigrationPairingService, {
      exchangeMigrationPairing: (request) => this.target.exchange(request),
    });
  }

  /** The mutual-TLS branch of the server's Network access (network.ts). */
  handler() {
    return migrationHandler(
      (router) =>
        router.service(migration.MigrationService, {
          negotiate: (request, context) => {
            const peer = context.values.get(migrationPeer);

            if (!peer) throw new ConnectError("Migration not found", Code.NotFound);

            return this.target.negotiate(peer, request);
          },
        }),
      (pin) => this.target.authorize(pin),
    );
  }
}
