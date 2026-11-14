import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { serverMigration as migration, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { pinnedCertificate, routedPinnedTransport } from "@canopy/transport";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { openListener } from "../../apps/gateway/src/network/listener.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { signBinding } from "../../apps/gateway/src/server-migration/binding.ts";
import { IDENTITY_CHANGED, migrationClient, pairingClient } from "../../apps/gateway/src/server-migration/channel.ts";
import { TARGET_NOT_EMPTY } from "../../apps/gateway/src/server-migration/context.ts";
import { ServerMigrations } from "../../apps/gateway/src/server-migration/service.ts";
import { decryptSecret } from "../../apps/gateway/src/store/secrets.ts";
import { MIGRATION_FENCE, migrationFenced, toConnectError } from "../../apps/gateway/src/api/ui-errors.ts";
import { GatewayStore } from "@canopy/gateway/store";
import {
  SERVICE_TOKEN,
  startBareGateway,
  startTestGateway,
  type BareTestGateway,
  type TestGateway,
} from "./support/gateway.ts";

type Refusal = { code: Code | "resolved"; message: string };

const refusal = (call: Promise<unknown>): Promise<Refusal> =>
  call.then(
    () => ({ code: "resolved" as const, message: "resolved" }),
    (error: Error) => {
      const e = ConnectError.from(error);

      return { code: e.code, message: e.rawMessage };
    },
  );

async function networkOf(gw: BareTestGateway, role: "server" | "desktop") {
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

/** A home played by the test: its own computer and session keys, every request field under control. */
async function rawHome(invitation: ui.ServerMigrationInvitation) {
  const computer = await generateIdentity();
  const session = await generateIdentity({ name: "Canopy server migration", validDays: 30 });
  const origin = invitation.origins[0]!;

  const target = {
    origin,
    certificate: await pinnedCertificate(origin, invitation.fingerprint),
    fingerprint: invitation.fingerprint,
  };

  const exchange = (
    versions: MessageInitShape<typeof migration.MigrationVersionsSchema>,
    overrides: { code?: string; computerCertificate?: string } = {},
  ) =>
    pairingClient(target).exchangeMigrationPairing({
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

  return { computer, session, target, exchange, client: () => migrationClient(target, session) };
}

describe.skipIf(!dockerAvailable)("server migration sessions: two gateways, pinned mutual TLS", () => {
  let server: BareTestGateway;
  let desktop: TestGateway;
  let serverNet: Awaited<ReturnType<typeof networkOf>>;
  let desktopNet: Awaited<ReturnType<typeof networkOf>>;
  let local: { protocol: number; build: string; schema: string; capabilities: string[] };

  const serverQuery = <A extends object>(text: string, params: unknown[] = []) =>
    server.core.serverMigration.store.query<A>(text, params);

  const desktopQuery = <A extends object>(text: string, params: unknown[] = []) =>
    desktop.core.serverMigration.store.query<A>(text, params);

  const actions = async (query: typeof serverQuery, sessionId: string) =>
    (
      await query<{ action: string; details: Record<string, string | number> }>(
        "SELECT action, details FROM audit_log WHERE target_type='server_migration' AND target_id=$1::uuid ORDER BY created_at",
        [sessionId],
      )
    ).map((row) => `${row.action}:${JSON.stringify(row.details)}`);

  beforeAll(async () => {
    server = await startBareGateway({ role: "server" });
    desktop = await startTestGateway({ role: "desktop" });
    serverNet = await networkOf(server, "server");
    desktopNet = await networkOf(desktop, "desktop");
    local = await server.core.serverMigration.target.context.versions();
  }, 90_000);

  afterAll(async () => {
    await serverNet?.close();
    await desktopNet?.close();
    await desktop?.close();
    await server?.close();
  });

  test("an impersonated or unpinned server gets no code; a server serves no other certificate", async () => {
    const invitation = await server.api.createServerMigrationInvitation({});
    // A false route: another certificate at an address listed first. It must never see an HTTP request.
    const impostor = await generateIdentity();
    let requests = 0;

    const listener = await openListener({
      host: "127.0.0.1",
      port: 0,
      identity: impostor,
      route: () => (_request, response) => {
        requests++;
        response.writeHead(404);
        response.end();
      },
    });

    const impersonated = { ...invitation, origins: [`https://127.0.0.1:${listener.port}`] };
    const pair = (value: ui.ServerMigrationInvitation) => desktop.api.pairServerMigration({ invitation: value });
    expect(await refusal(pair(impersonated))).toEqual({ code: Code.PermissionDenied, message: IDENTITY_CHANGED });
    const unpinned = { ...invitation, fingerprint: "0".repeat(64) };
    expect(await refusal(pair(unpinned))).toEqual({ code: Code.PermissionDenied, message: IDENTITY_CHANGED });
    expect((await refusal(pair({ ...invitation, fingerprint: "abc" }))).code).toBe(Code.InvalidArgument);
    await listener.close();
    expect(requests).toBe(0);
    // Nothing was stored or consumed: the desktop has no session, the invitation still works.
    expect((await desktop.api.getServerMigration({})).session).toBeUndefined();

    const sources = await serverQuery<{ exchanged_at: Date | null }>(
      "SELECT exchanged_at FROM server_migration_sources",
    );

    expect(sources[0]?.exchanged_at).toBeNull();

    // A linked computer's certificate (or any other) reaches no service on a server.
    const computer = await desktopNet.network.options.store.identity();
    const home = await rawHome(invitation);
    const linked = migrationClient(home.target, { certificate: computer.certificate, privateKey: computer.privateKey });
    const forged = await refusal(linked.negotiate({ sessionId: invitation.sessionId, sourceId: invitation.sourceId }));
    expect(forged.code).not.toBe("resolved");

    // Without a client certificate the device listener has no MigrationService either.
    const anonymous = createClient(
      migration.MigrationService,
      routedPinnedTransport(server.core.mobile.networkRoutes()).transport,
    );

    expect((await refusal(anonymous.negotiate({ sessionId: invitation.sessionId }))).code).not.toBe("resolved");
  });

  test("a desktop pairs, both owners confirm the pins, and negotiation moves no data", async () => {
    const before = (await server.api.getServerMigration({})).session!;
    const invitation = await server.api.createServerMigrationInvitation({});
    expect(invitation.sessionId).toBe(before.id);
    expect(invitation.code).toHaveLength(43);
    await desktop.api.pairServerMigration({ invitation });

    const onServer = (await server.api.getServerMigration({})).session!;
    const home = onServer.peers.find((peer) => peer.id === invitation.sourceId)!;
    expect(onServer).toMatchObject({ role: "target", state: "paired", build: local.build, schema: local.schema });
    expect(home).toMatchObject({ paired: true, confirmed: false, negotiated: false });
    expect(home.nodeId).toBe((await desktopNet.network.options.store.identity()).nodeId);

    const onDesktop = (await desktop.api.getServerMigration({})).session!;
    expect(onDesktop).toMatchObject({ id: invitation.sessionId, role: "source", state: "paired" });
    expect(onDesktop.peers[0]).toMatchObject({ fingerprint: invitation.fingerprint, paired: true, confirmed: false });
    expect(onDesktop.peers[0]!.nodeId).toBe((await serverNet.network.options.store.identity()).nodeId);

    // Nothing runs before both owners compared the pins.
    const negotiate = () => desktop.api.negotiateServerMigration({ sessionId: invitation.sessionId });
    expect((await refusal(negotiate())).message).toContain("Confirm the server's pin");
    await desktop.api.confirmServerMigrationPeer({
      sessionId: invitation.sessionId,
      fingerprint: invitation.fingerprint,
    });
    expect(await refusal(negotiate())).toEqual({
      code: Code.FailedPrecondition,
      message: "Confirm this computer on the server first.",
    });

    const confirm = (fingerprint: string) =>
      server.api.confirmServerMigrationPeer({ sessionId: invitation.sessionId, sourceId: home.id, fingerprint });

    expect((await refusal(confirm("f".repeat(64)))).code).toBe(Code.PermissionDenied);
    await confirm(home.fingerprint);
    await negotiate();
    expect((await server.api.getServerMigration({})).session!.peers.find((p) => p.id === home.id)!.negotiated).toBe(
      true,
    );
    expect((await desktop.api.getServerMigration({})).session!.peers[0]).toMatchObject({
      negotiated: true,
      build: local.build,
      schema: local.schema,
    });

    // While reserved, the server admits no new root data from any client or job.
    const intrusion = await server.addWorker("intruder").catch((error: Error) => error);
    expect(migrationFenced(intrusion)).toBe(true);
    expect(toConnectError(intrusion)).toMatchObject({ code: Code.FailedPrecondition, rawMessage: MIGRATION_FENCE });
    // Each producer keeps its own wording; the database refusal holds for all of them.
    expect((await refusal(server.api.createWorkerEnrollment({ name: "Intruder" }))).code).toBe(Code.FailedPrecondition);
    expect(await serverQuery("SELECT 1 FROM workers")).toHaveLength(0);

    // Audit on both sides, without codes, keys or addresses.
    const serverAudit = await actions(serverQuery, invitation.sessionId);
    const desktopAudit = await actions(desktopQuery, invitation.sessionId);
    expect(serverAudit.filter((a) => a.includes(invitation.sourceId)).map((a) => a.split(":")[0])).toEqual([
      "server_migration.pair",
      "server_migration.pair",
      "server_migration.pair",
      "server_migration.negotiate",
    ]);
    expect(desktopAudit.map((a) => a.split(":")[0])).toEqual([
      "server_migration.pair",
      "server_migration.pair",
      "server_migration.negotiate",
      "server_migration.negotiate",
    ]);
    expect(desktopAudit.at(-2)).toContain('"reason":"FailedPrecondition"');
    expect(desktopAudit.at(-1)).toContain('"result":"accepted"');

    for (const line of [...serverAudit, ...desktopAudit]) {
      expect(line).not.toContain(invitation.code);
      expect(line).not.toContain("127.0.0.1");
      expect(line).not.toContain("PRIVATE KEY");
    }

    // The code is stored only as a hash; the session key only encrypted with the desktop's key.
    const stored = await serverQuery<{ row: string }>(
      "SELECT row_to_json(x)::text AS row FROM server_migration_sources x",
    );

    expect(stored.every((row) => !row.row.includes(invitation.code))).toBe(true);
    const keys = await desktopQuery<{ private_key: Uint8Array }>("SELECT private_key FROM server_migration_targets");
    const ciphertext = keys[0]!.private_key;
    expect(Buffer.from(ciphertext).toString("latin1")).not.toContain("PRIVATE KEY");
    expect(decryptSecret(desktop.secretsKey, ciphertext)).toContain("PRIVATE KEY");
  });

  test("an invitation is used once: the same key gets the same reply, another key and wrong codes are refused", async () => {
    const invitation = await server.api.createServerMigrationInvitation({});
    const home = await rawHome(invitation);
    const first = await home.exchange(local);
    const retry = await home.exchange(local);
    expect(retry).toEqual(first);

    const intruder = await rawHome(invitation);
    expect((await refusal(intruder.exchange(local))).code).toBe(Code.PermissionDenied);
    // A signature from another computer key, or for another certificate, proves nothing.
    expect((await refusal(intruder.exchange(local, { computerCertificate: home.computer.certificate }))).code).toBe(
      Code.PermissionDenied,
    );

    const next = await server.api.createServerMigrationInvitation({});
    const guesser = await rawHome(next);

    for (let attempt = 0; attempt < 5; attempt++)
      expect((await refusal(guesser.exchange(local, { code: "A".repeat(43) }))).code).toBe(Code.PermissionDenied);
    // Five wrong codes revoke the invitation: even the right code is refused now.
    expect((await refusal(guesser.exchange(local))).code).toBe(Code.PermissionDenied);
  });

  test("a version skew is refused at pairing and at negotiation", async () => {
    const invitation = await server.api.createServerMigrationInvitation({});
    const home = await rawHome(invitation);

    for (const skew of [
      { ...local, build: "0.0.1-older" },
      { ...local, schema: "146_github_pr_last_known" },
      { ...local, protocol: local.protocol + 1 },
      { ...local, capabilities: [] },
    ]) {
      const refused = await refusal(home.exchange(skew));
      expect(refused.code).toBe(Code.FailedPrecondition);
      expect(refused.message).toContain("Update Canopy");
    }

    // Refused before the code was used: the same invitation pairs once versions match.
    await home.exchange(local);
    await server.api.confirmServerMigrationPeer({
      sessionId: invitation.sessionId,
      sourceId: invitation.sourceId,
      fingerprint: home.session.fingerprint,
    });

    const negotiate = (versions: typeof local) =>
      home
        .client()
        .negotiate({ sessionId: invitation.sessionId, sourceId: invitation.sourceId, generation: 1, versions });

    const refused = await refusal(negotiate({ ...local, build: "9.9.9-newer" }));
    expect(refused.code).toBe(Code.FailedPrecondition);
    expect((await actions(serverQuery, invitation.sessionId)).at(-1)).toContain('"reason":"version_build"');
    expect((await negotiate(local)).versions).toMatchObject({ build: local.build, schema: local.schema });
  });

  test("another owner can't see or drive a session, and phones can't prepare one", async () => {
    const session = (await server.api.getServerMigration({})).session!;
    const home = session.peers.find((peer) => peer.negotiated)!;

    const other = await server.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("other@localhost", "Other owner")),
    );

    const foreign = new ServerMigrations({
      runtime: server.runtime,
      owner: other,
      role: "server",
      network: () => serverNet.network,
    });

    try {
      expect((await foreign.snapshot()).session).toBeUndefined();
      const missing = { code: Code.NotFound, message: "Migration not found" };
      expect(await refusal(foreign.target.confirm(session.id, home.id, home.fingerprint))).toEqual(missing);
      expect(await refusal(foreign.target.revoke(session.id, home.id))).toEqual(missing);
      expect(await refusal(foreign.target.revoke(session.id, ""))).toEqual(missing);
      expect(await refusal(foreign.target.confirm(crypto.randomUUID(), home.id, home.fingerprint))).toEqual(missing);
      // Another owner's data makes the server non-empty for both: v1 never merges owners.
      expect((await refusal(foreign.target.invite())).message).toBe(TARGET_NOT_EMPTY);
    } finally {
      await serverQuery("DELETE FROM users WHERE id=$1::uuid", [other]);
    }

    // A session credential drives only its own session.
    const invitation = await server.api.createServerMigrationInvitation({});
    const raw = await rawHome(invitation);
    await raw.exchange(local);

    const elsewhere = await refusal(
      raw.client().negotiate({ sessionId: session.id, sourceId: home.id, generation: 1, versions: local }),
    );

    expect(elsewhere).toEqual({ code: Code.NotFound, message: "Migration not found" });

    // A phone paired with this server has the owner's UI, but not this.
    const pairing = await server.api.createMobilePairing({});
    const routes = server.core.mobile.networkRoutes();

    const phone = await createClient(
      ui.MobilePairingService,
      routedPinnedTransport(routes).transport,
    ).exchangeMobilePairing({
      code: pairing.code,
      name: "Phone",
      platform: "ios",
    });

    const phoneApi = createClient(ui.GatewayService, routedPinnedTransport(routes, phone.deviceToken).transport);
    expect((await refusal(phoneApi.getServerMigration({}))).code).toBe(Code.PermissionDenied);
    expect((await refusal(phoneApi.createServerMigrationInvitation({}))).code).toBe(Code.PermissionDenied);
    // Roles: a desktop gateway never imports, a server never exports.
    expect((await refusal(desktop.api.createServerMigrationInvitation({}))).code).toBe(Code.FailedPrecondition);
    expect((await refusal(server.api.negotiateServerMigration({ sessionId: session.id }))).code).toBe(
      Code.FailedPrecondition,
    );
  });

  test("revoking a home closes its credential; aborting lifts the reservation; a used server is refused", async () => {
    const session = (await server.api.getServerMigration({})).session!;
    const { nodeId } = await desktopNet.network.options.store.identity();
    const home = session.peers.find((peer) => peer.nodeId === nodeId)!;
    await server.api.revokeServerMigration({ sessionId: session.id, sourceId: home.id });
    const refused = await refusal(desktop.api.negotiateServerMigration({ sessionId: session.id }));
    expect(refused.code).not.toBe("resolved");
    expect((await actions(desktopQuery, session.id)).at(-1)).toContain('"result":"refused"');

    await server.api.revokeServerMigration({ sessionId: session.id, sourceId: "" });
    expect((await server.api.getServerMigration({})).session).toBeUndefined();
    expect((await actions(serverQuery, session.id)).at(-1)).toContain('"scope":"session"');
    await desktop.api.revokeServerMigration({ sessionId: session.id });
    expect((await desktop.api.getServerMigration({})).session).toBeUndefined();

    // The reservation is gone: the server takes data again, and with data it is no import target.
    await server.addWorker("own worker");
    expect(await refusal(server.api.createServerMigrationInvitation({}))).toEqual({
      code: Code.FailedPrecondition,
      message: TARGET_NOT_EMPTY,
    });
  });
});
