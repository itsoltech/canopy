import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { serverMigration as migration, ui } from "@canopy/contracts";
import { pinnedCertificate } from "@canopy/transport";
import { ComputerStore } from "../../../apps/gateway/src/computers/store.ts";
import { generateIdentity } from "../../../apps/gateway/src/computers/identity.ts";
import { mountMobileNetwork } from "../../../apps/gateway/src/network/devices.ts";
import { NetworkAccess } from "../../../apps/gateway/src/network/network.ts";
import { signBinding } from "../../../apps/gateway/src/server-migration/binding.ts";
import { migrationClient, pairingClient } from "../../../apps/gateway/src/server-migration/channel.ts";
import type { MigrationStore } from "../../../apps/gateway/src/server-migration/store.ts";
import type { Versions } from "../../../apps/gateway/src/server-migration/versions.ts";
import { SERVICE_TOKEN, startBareGateway, type BareTestGateway } from "./gateway.ts";

export type Refusal = { code: Code | "resolved"; message: string };

export const refusal = (call: Promise<unknown>): Promise<Refusal> =>
  call.then(
    () => ({ code: "resolved" as const, message: "resolved" }),
    (error: Error) => {
      const e = ConnectError.from(error);

      return { code: e.code, message: e.rawMessage };
    },
  );

/** Both gateways in tests run from source (0.0.0-dev); they opt in like a local development stack. */
export const DEV_BUILDS = "CANOPY_SERVER_MIGRATION_DEV_BUILDS";

export async function networkOf(gw: BareTestGateway, role: "server" | "desktop") {
  const network = new NetworkAccess({
    role,
    store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
    host: "127.0.0.1",
  });

  gw.core.network = network;
  const unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
  await network.start();

  if (role === "server")
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));

  return { network, close: async () => (unmount(), await network.close()) };
}

export type MigrationPair = Awaited<ReturnType<typeof startMigrationPair>>;

/** A new server (no worker, Network access on) and a desktop's local gateway, each with its own database and
 * secrets key. Every test case gets its own pair. */
export async function startMigrationPair() {
  const previous = process.env[DEV_BUILDS];
  process.env[DEV_BUILDS] = "1";
  const server = await startBareGateway({ role: "server" });
  const desktop = await startBareGateway({ role: "desktop" });
  const serverNet = await networkOf(server, "server");
  const desktopNet = await networkOf(desktop, "desktop");
  const local = await server.core.serverMigration.target.context.versions();

  const sql = <A extends object>(gw: BareTestGateway, text: string, params: unknown[] = []) =>
    gw.core.serverMigration.store.query<A>(text, params);

  return {
    server,
    desktop,
    serverNet,
    desktopNet,
    local,
    serverSql: <A extends object>(text: string, params: unknown[] = []) => sql<A>(server, text, params),
    desktopSql: <A extends object>(text: string, params: unknown[] = []) => sql<A>(desktop, text, params),
    close: async () => {
      await serverNet.close();
      await desktopNet.close();
      await desktop.close();
      await server.close();

      if (previous === undefined) delete process.env[DEV_BUILDS];
      else process.env[DEV_BUILDS] = previous;
    },
  };
}

/** Audit records of one session, in write order (clock_timestamp, then id), as `action phase/result`. */
export async function auditOf(store: MigrationStore, sessionId: string) {
  const rows = await store.query<{ action: string; details: Record<string, string | number> }>(
    `SELECT action, details FROM audit_log WHERE target_type='server_migration' AND target_id=$1::uuid
    ORDER BY created_at, id`,
    [sessionId],
  );

  return rows.map((row) => ({ action: row.action, details: row.details, text: JSON.stringify(row.details) }));
}

/** A home played by the test: its own computer and session keys, every request field under control. */
export async function rawHome(invitation: ui.ServerMigrationInvitation) {
  const computer = await generateIdentity();
  const session = await generateIdentity({ name: "Canopy server migration", validDays: 30 });
  const origin = invitation.origins[0]!;

  const target = {
    origin,
    certificate: await pinnedCertificate(origin, invitation.fingerprint),
    fingerprint: invitation.fingerprint,
  };

  const request = (versions: Versions, overrides: { code?: string; computerCertificate?: string } = {}) =>
    create(migration.ExchangeMigrationPairingRequestSchema, {
      sessionId: invitation.sessionId,
      sourceId: invitation.sourceId,
      code: invitation.code,
      sessionCertificate: session.certificate,
      computerCertificate: computer.certificate,
      bindingSignature: signBinding(computer.privateKey, {
        sessionId: invitation.sessionId,
        sourceId: invitation.sourceId,
        sessionPin: session.fingerprint,
        targetPin: invitation.fingerprint,
      }),
      sourceName: "Raw home",
      sourceOwnerId: crypto.randomUUID(),
      versions,
      ...overrides,
    });

  const exchange = (versions: Versions, overrides: { code?: string; computerCertificate?: string } = {}) =>
    pairingClient(target).exchangeMigrationPairing(request(versions, overrides));

  const negotiate = (versions: MessageInitShape<typeof migration.MigrationVersionsSchema>, sessionId?: string) =>
    migrationClient(target, session).negotiate({
      sessionId: sessionId ?? invitation.sessionId,
      sourceId: invitation.sourceId,
      generation: 1,
      versions,
    });

  return { computer, session, target, request, exchange, negotiate };
}
