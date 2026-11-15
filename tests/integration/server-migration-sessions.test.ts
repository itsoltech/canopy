import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import * as https from "node:https";
import { Code, createClient } from "@connectrpc/connect";
import { serverMigration as migration, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { routedPinnedTransport } from "@canopy/transport";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { openListener } from "../../apps/gateway/src/network/listener.ts";
import { IDENTITY_CHANGED, migrationClient } from "../../apps/gateway/src/server-migration/channel.ts";
import { TARGET_NOT_EMPTY } from "../../apps/gateway/src/server-migration/context.ts";
import { ServerMigrations } from "../../apps/gateway/src/server-migration/service.ts";
import { decryptSecret, encryptSecret } from "../../apps/gateway/src/store/secrets.ts";
import { startBareGateway } from "./support/gateway.ts";
import { auditOf, rawHome, refusal, startMigrationPair, type MigrationPair } from "./support/server-migration.ts";

const MISSING = { code: Code.NotFound, message: "Migration not found" };

describe.skipIf(!dockerAvailable)("server migration sessions: two gateways, pinned mutual TLS", () => {
  let env: MigrationPair;

  beforeEach(async () => {
    env = await startMigrationPair();
  }, 60_000);

  afterEach(async () => {
    await env?.close();
  });

  /** The desktop pairs through its RPC and both owners confirm the pins. */
  async function pairDesktop() {
    const invitation = await env.server.api.createServerMigrationInvitation({});
    await env.desktop.api.pairServerMigration({ invitation });

    const home = (await env.server.api.getServerMigration({})).session!.peers.find(
      (p) => p.id === invitation.sourceId,
    )!;

    await env.desktop.api.confirmServerMigrationPeer({
      sessionId: invitation.sessionId,
      fingerprint: invitation.fingerprint,
    });
    await env.server.api.confirmServerMigrationPeer({
      sessionId: invitation.sessionId,
      sourceId: home.id,
      fingerprint: home.fingerprint,
    });

    return { invitation, home };
  }

  /** The same desktop running another build: its own service on the desktop's database and identity. */
  const olderDesktop = () =>
    new ServerMigrations({
      runtime: env.desktop.runtime,
      owner: env.desktop.userId,
      role: "desktop",
      network: () => env.desktopNet.network,
      build: "1.0.0-old",
      allowDevBuilds: true,
    });

  test("an impersonated or unpinned server gets no code; a server serves no other certificate", async () => {
    const invitation = await env.server.api.createServerMigrationInvitation({});
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

    const pair = (value: ui.ServerMigrationInvitation) => env.desktop.api.pairServerMigration({ invitation: value });
    const impersonated = { ...invitation, origins: [`https://127.0.0.1:${listener.port}`] };
    expect(await refusal(pair(impersonated))).toEqual({ code: Code.PermissionDenied, message: IDENTITY_CHANGED });
    expect(await refusal(pair({ ...invitation, fingerprint: "0".repeat(64) }))).toEqual({
      code: Code.PermissionDenied,
      message: IDENTITY_CHANGED,
    });
    expect((await refusal(pair({ ...invitation, fingerprint: "abc" }))).code).toBe(Code.InvalidArgument);
    await listener.close();
    expect(requests).toBe(0);
    // Nothing was stored or consumed.
    expect((await env.desktop.api.getServerMigration({})).session).toBeUndefined();
    expect(await env.serverSql("SELECT 1 FROM server_migration_sources WHERE exchanged_at IS NOT NULL")).toEqual([]);

    // A linked computer's certificate (or any other) reaches no service on a server.
    const computer = await env.desktopNet.network.options.store.identity();
    const home = await rawHome(invitation);
    const linked = migrationClient(home.target, { certificate: computer.certificate, privateKey: computer.privateKey });
    expect((await refusal(linked.negotiate({ sessionId: invitation.sessionId }))).code).not.toBe("resolved");

    // Without a client certificate the device listener has no MigrationService either.
    const anonymous = createClient(
      migration.MigrationService,
      routedPinnedTransport(env.server.core.mobile.networkRoutes()).transport,
    );

    expect((await refusal(anonymous.negotiate({ sessionId: invitation.sessionId }))).code).not.toBe("resolved");
  });

  test("a desktop pairs, both owners confirm the pins, and negotiation moves no data", async () => {
    const invitation = await env.server.api.createServerMigrationInvitation({});
    expect(invitation.code).toHaveLength(43);
    await env.desktop.api.pairServerMigration({ invitation });

    const onServer = (await env.server.api.getServerMigration({})).session!;
    const home = onServer.peers[0]!;
    expect(onServer).toMatchObject({ role: "target", state: "paired", build: env.local.build });
    expect(home).toMatchObject({ id: invitation.sourceId, paired: true, confirmed: false, negotiated: false });
    expect(home.nodeId).toBe((await env.desktopNet.network.options.store.identity()).nodeId);
    const onDesktop = (await env.desktop.api.getServerMigration({})).session!;
    expect(onDesktop).toMatchObject({ id: invitation.sessionId, role: "source", state: "paired" });
    expect(onDesktop.peers[0]).toMatchObject({ fingerprint: invitation.fingerprint, paired: true, confirmed: false });

    const negotiate = () => env.desktop.api.negotiateServerMigration({ sessionId: invitation.sessionId });
    expect((await refusal(negotiate())).message).toContain("Confirm the server's pin");
    await env.desktop.api.confirmServerMigrationPeer({
      sessionId: invitation.sessionId,
      fingerprint: invitation.fingerprint,
    });
    expect(await refusal(negotiate())).toEqual({
      code: Code.FailedPrecondition,
      message: "Confirm this computer on the server first.",
    });

    const confirm = (fingerprint: string) =>
      env.server.api.confirmServerMigrationPeer({ sessionId: invitation.sessionId, sourceId: home.id, fingerprint });

    expect((await refusal(confirm("f".repeat(64)))).code).toBe(Code.PermissionDenied);
    await confirm(home.fingerprint);
    await negotiate();
    expect((await env.server.api.getServerMigration({})).session!.peers[0]!.negotiated).toBe(true);
    expect((await env.desktop.api.getServerMigration({})).session!.peers[0]).toMatchObject({
      negotiated: true,
      build: env.local.build,
      schema: env.local.schema,
    });

    // Audit on both sides, in write order, without codes, keys or addresses.
    const serverAudit = await auditOf(env.server.core.serverMigration.store, invitation.sessionId);
    const desktopAudit = await auditOf(env.desktop.core.serverMigration.store, invitation.sessionId);
    expect(serverAudit.map((a) => `${a.action} ${a.details["phase"] ?? a.details["result"]}`)).toEqual([
      "server_migration.pair invited",
      "server_migration.pair exchanged",
      "server_migration.pair confirmed",
      "server_migration.negotiate accepted",
    ]);
    expect(desktopAudit.map((a) => `${a.action} ${a.details["phase"] ?? a.details["result"]}`)).toEqual([
      "server_migration.pair exchanged",
      "server_migration.pair confirmed",
      "server_migration.negotiate refused",
      "server_migration.negotiate accepted",
    ]);

    for (const { text } of [...serverAudit, ...desktopAudit]) {
      expect(text).not.toContain(invitation.code);
      expect(text).not.toContain("127.0.0.1");
      expect(text).not.toContain("PRIVATE KEY");
    }

    // The code only as a hash; the server's addresses and the session key only encrypted with the desktop's key.
    const stored = await env.serverSql<{ row: string }>(
      "SELECT row_to_json(x)::text AS row FROM server_migration_sources x",
    );

    expect(stored.every((row) => !row.row.includes(invitation.code))).toBe(true);

    const targets = await env.desktopSql<{ row: string; origins: Uint8Array; private_key: Uint8Array }>(
      "SELECT row_to_json(t)::text AS row, origins, private_key FROM server_migration_targets t",
    );

    expect(targets[0]!.row).not.toContain("127.0.0.1");
    expect(targets[0]!.row).not.toContain("PRIVATE KEY");
    expect(decryptSecret(env.desktop.secretsKey, targets[0]!.origins).split("\n")).toEqual(invitation.origins);
    expect(decryptSecret(env.desktop.secretsKey, targets[0]!.private_key)).toContain("PRIVATE KEY");
  });

  test("a damaged or foreign address envelope is refused without naming the address", async () => {
    const { invitation } = await pairDesktop();
    const negotiate = () => refusal(env.desktop.api.negotiateServerMigration({ sessionId: invitation.sessionId }));
    const pairAgain = "This computer can't read its pairing with the server. Cancel the move and pair again.";

    await env.desktopSql("UPDATE server_migration_targets SET origins=$1", [randomBytes(40)]);
    expect(await negotiate()).toEqual({ code: Code.FailedPrecondition, message: pairAgain });
    await env.desktopSql("UPDATE server_migration_targets SET origins=$1", [
      encryptSecret(randomBytes(32), invitation.origins.join("\n")),
    ]);
    expect(await negotiate()).toEqual({ code: Code.FailedPrecondition, message: pairAgain });
    await env.desktopSql("UPDATE server_migration_targets SET origins=$1", [
      encryptSecret(env.desktop.secretsKey, "http://plain.example\n"),
    ]);
    expect(await negotiate()).toEqual({ code: Code.FailedPrecondition, message: pairAgain });
    // Restored, it connects again.
    await env.desktopSql("UPDATE server_migration_targets SET origins=$1", [
      encryptSecret(env.desktop.secretsKey, invitation.origins.join("\n")),
    ]);
    expect((await negotiate()).code).toBe("resolved");
  });

  test("an invitation is used once: the same key gets the same reply, another key and wrong codes are refused", async () => {
    const invitation = await env.server.api.createServerMigrationInvitation({});
    const home = await rawHome(invitation);
    const first = await home.exchange(env.local);
    expect(await home.exchange(env.local)).toEqual(first);
    const intruder = await rawHome(invitation);
    expect((await refusal(intruder.exchange(env.local))).code).toBe(Code.PermissionDenied);
    // A signature from another computer key proves nothing.
    expect((await refusal(intruder.exchange(env.local, { computerCertificate: home.computer.certificate }))).code).toBe(
      Code.PermissionDenied,
    );

    const next = await env.server.api.createServerMigrationInvitation({});
    const guesser = await rawHome(next);

    for (let attempt = 0; attempt < 5; attempt++)
      expect((await refusal(guesser.exchange(env.local, { code: "A".repeat(43) }))).code).toBe(Code.PermissionDenied);
    // Five wrong codes revoke the invitation: even the right code is refused now.
    expect((await refusal(guesser.exchange(env.local))).code).toBe(Code.PermissionDenied);
  });

  test("a version skew is refused at pairing and negotiation; dev builds need an explicit opt-in", async () => {
    const invitation = await env.server.api.createServerMigrationInvitation({});
    const home = await rawHome(invitation);

    for (const skew of [
      { ...env.local, build: "0.0.1-older" },
      { ...env.local, schema: "146_github_pr_last_known" },
      { ...env.local, protocol: env.local.protocol + 1 },
      { ...env.local, capabilities: [] },
    ]) {
      const refused = await refusal(home.exchange(skew));
      expect(refused.code).toBe(Code.FailedPrecondition);
      expect(refused.message).toContain("Update Canopy");
    }

    // A server that doesn't opt in never pairs two development builds, even when they report the same version.
    const strict = new ServerMigrations({
      runtime: env.server.runtime,
      owner: env.server.userId,
      role: "server",
      network: () => env.serverNet.network,
      allowDevBuilds: false,
    });

    expect(await refusal(strict.target.exchange(home.request(env.local)))).toEqual({
      code: Code.FailedPrecondition,
      message: "Development builds of Canopy can't move data. Install a released version on both computers.",
    });

    // Refused before the code was used: the same invitation pairs once versions match.
    await home.exchange(env.local);
    await env.server.api.confirmServerMigrationPeer({
      sessionId: invitation.sessionId,
      sourceId: invitation.sourceId,
      fingerprint: home.session.fingerprint,
    });
    expect((await refusal(home.negotiate({ ...env.local, build: "9.9.9-newer" }))).code).toBe(Code.FailedPrecondition);
    const audit = await auditOf(env.server.core.serverMigration.store, invitation.sessionId);
    expect(audit.filter((a) => a.details["result"] === "refused").map((a) => a.details["reason"])).toEqual([
      "version_build",
    ]);
    expect((await home.negotiate(env.local)).versions).toMatchObject({ build: env.local.build });
  });

  test("after an update, the same invitation pairs and the session pins the new build", async () => {
    const invitation = await env.server.api.createServerMigrationInvitation({});
    const refused = await refusal(olderDesktop().source.pair(invitation));
    expect(refused.code).toBe(Code.FailedPrecondition);
    expect(refused.message).toContain("1.0.0-old");

    const before = await env.desktopSql<{ build_version: string; state: string }>(
      "SELECT build_version, state FROM server_migration_sessions",
    );

    expect(before).toEqual([{ build_version: "1.0.0-old", state: "pairing" }]);

    // Updated: the desktop RPC retries the same invitation with the stored key and its new build.
    await env.desktop.api.pairServerMigration({ invitation });

    const after = await env.desktopSql<{ build_version: string; state: string }>(
      "SELECT build_version, state FROM server_migration_sessions",
    );

    expect(after).toEqual([{ build_version: env.local.build, state: "paired" }]);
    const home = (await env.server.api.getServerMigration({})).session!.peers[0]!;
    await env.desktop.api.confirmServerMigrationPeer({
      sessionId: invitation.sessionId,
      fingerprint: invitation.fingerprint,
    });
    await env.server.api.confirmServerMigrationPeer({
      sessionId: invitation.sessionId,
      sourceId: home.id,
      fingerprint: home.fingerprint,
    });
    await env.desktop.api.negotiateServerMigration({ sessionId: invitation.sessionId });
    const attempts = await auditOf(env.desktop.core.serverMigration.store, invitation.sessionId);
    expect(attempts.find((a) => a.details["phase"] === "exchanged")?.details["attempt"]).toBe("retry");
  });

  test("a replacement invitation replaces an unexchanged attempt and its key", async () => {
    const first = await env.server.api.createServerMigrationInvitation({});
    expect((await refusal(olderDesktop().source.pair(first))).code).toBe(Code.FailedPrecondition);

    const abandoned = await env.desktopSql<{ certificate_pin: string }>(
      "SELECT certificate_pin FROM server_migration_targets",
    );

    const second = await env.server.api.createServerMigrationInvitation({});
    expect(second.sessionId).toBe(first.sessionId);
    // The same source with another server pin is not a retry.
    const swapped = { ...first, fingerprint: "e".repeat(64) };
    expect((await refusal(env.desktop.api.pairServerMigration({ invitation: swapped }))).code).toBe(
      Code.PermissionDenied,
    );
    await env.desktop.api.pairServerMigration({ invitation: second });

    const target = await env.desktopSql<{ source_id: string; certificate_pin: string }>(
      "SELECT source_id, certificate_pin FROM server_migration_targets",
    );

    expect(target).toHaveLength(1);
    expect(target[0]!.source_id).toBe(second.sourceId);
    expect(target[0]!.certificate_pin).not.toBe(abandoned[0]!.certificate_pin);
    const peers = (await env.server.api.getServerMigration({})).session!.peers;
    expect(peers.find((p) => p.id === first.sourceId)).toMatchObject({ paired: false });
    const home = peers.find((p) => p.id === second.sourceId)!;
    expect(home).toMatchObject({ paired: true, fingerprint: target[0]!.certificate_pin });

    await env.desktop.api.confirmServerMigrationPeer({ sessionId: second.sessionId, fingerprint: second.fingerprint });
    await env.server.api.confirmServerMigrationPeer({
      sessionId: second.sessionId,
      sourceId: second.sourceId,
      fingerprint: home.fingerprint,
    });
    // Negotiate sends the replacement's source id; the abandoned one would be NotFound.
    await env.desktop.api.negotiateServerMigration({ sessionId: second.sessionId });
    const attempts = await auditOf(env.desktop.core.serverMigration.store, second.sessionId);
    expect(attempts.find((a) => a.details["phase"] === "exchanged")?.details["attempt"]).toBe("replaced");
  });

  test("another owner's authenticated identity can't see or drive a session; phones can't prepare one", async () => {
    const { invitation, home } = await pairDesktop();
    // A session credential drives only its own session.
    const raw = await rawHome(await env.server.api.createServerMigrationInvitation({}));
    await raw.exchange(env.local);
    expect(await refusal(raw.negotiate(env.local, crypto.randomUUID()))).toEqual(MISSING);

    // A second owner of the same server database, with its own authenticated UI API. The fence refuses new
    // users on a reserved server; the test creates this hostile state around it.
    await env.serverSql("ALTER TABLE users DISABLE TRIGGER server_migration_fence");
    await env.serverSql(
      "INSERT INTO users (id, email, display_name, role) VALUES (gen_random_uuid(), 'other@localhost', 'Other', 'admin')",
    );
    await env.serverSql("ALTER TABLE users ENABLE TRIGGER server_migration_fence");

    const other = await startBareGateway({
      role: "server",
      ownerEmail: "other@localhost",
      storage: { pg: env.server.pg, secretsKey: env.server.secretsKey, workerId: "", workerCredential: "" },
    });

    try {
      other.core.network = env.serverNet.network;
      expect((await other.api.getServerMigration({})).session).toBeUndefined();
      const ids = { sessionId: invitation.sessionId, sourceId: home.id };
      expect(await refusal(other.api.confirmServerMigrationPeer({ ...ids, fingerprint: home.fingerprint }))).toEqual(
        MISSING,
      );
      expect(await refusal(other.api.revokeServerMigration(ids))).toEqual(MISSING);
      expect(await refusal(other.api.revokeServerMigration({ sessionId: invitation.sessionId }))).toEqual(MISSING);
      // The first owner's reservation (and data) leave nothing for the other owner to import into.
      expect(await refusal(other.api.createServerMigrationInvitation({}))).toEqual({
        code: Code.FailedPrecondition,
        message: TARGET_NOT_EMPTY,
      });
      // The other owner's device token doesn't authenticate on the first owner's API.
      const token = randomBytes(24).toString("base64url");
      await env.serverSql(
        `INSERT INTO mobile_devices (id, owner_user_id, name, platform, token_hash, pairing_version, client_kind)
        VALUES (gen_random_uuid(), $1::uuid, 'Other desktop', 'linux', $2, 2, 'desktop')`,
        [other.userId, createHash("sha256").update(token).digest("hex")],
      );
      const routes = env.server.core.mobile.networkRoutes();
      const foreignDevice = createClient(ui.GatewayService, routedPinnedTransport(routes, token).transport);
      expect((await refusal(foreignDevice.getServerMigration({}))).code).toBe(Code.Unauthenticated);
    } finally {
      await other.close(true);
    }

    // The session is intact for its owner.
    expect((await env.server.api.getServerMigration({})).session!.peers[0]!.confirmed).toBe(true);

    // A phone paired with this server has the owner's UI, but not this.
    const pairing = await env.server.api.createMobilePairing({});
    const routes = env.server.core.mobile.networkRoutes();

    const phone = await createClient(
      ui.MobilePairingService,
      routedPinnedTransport(routes).transport,
    ).exchangeMobilePairing({ code: pairing.code, name: "Phone", platform: "ios" });

    const phoneApi = createClient(ui.GatewayService, routedPinnedTransport(routes, phone.deviceToken).transport);
    expect((await refusal(phoneApi.getServerMigration({}))).code).toBe(Code.PermissionDenied);
    expect((await refusal(phoneApi.createServerMigrationInvitation({}))).code).toBe(Code.PermissionDenied);
    // Roles: a desktop gateway never imports, a server never exports.
    expect((await refusal(env.desktop.api.createServerMigrationInvitation({}))).code).toBe(Code.FailedPrecondition);
    expect((await refusal(env.server.api.negotiateServerMigration({ sessionId: invitation.sessionId }))).code).toBe(
      Code.FailedPrecondition,
    );
  });

  test("revoking a home closes its credential; aborting lifts the reservation; a used server is refused", async () => {
    const { invitation, home } = await pairDesktop();
    await env.server.api.revokeServerMigration({ sessionId: invitation.sessionId, sourceId: home.id });
    expect(
      (await refusal(env.desktop.api.negotiateServerMigration({ sessionId: invitation.sessionId }))).code,
    ).not.toBe("resolved");
    const desktopAudit = await auditOf(env.desktop.core.serverMigration.store, invitation.sessionId);
    expect(
      desktopAudit.filter((a) => a.action === "server_migration.negotiate").map((a) => a.details["result"]),
    ).toEqual(["refused"]);

    await env.server.api.revokeServerMigration({ sessionId: invitation.sessionId });
    expect((await env.server.api.getServerMigration({})).session).toBeUndefined();
    const serverAudit = await auditOf(env.server.core.serverMigration.store, invitation.sessionId);
    expect(serverAudit.filter((a) => a.action === "server_migration.abort").map((a) => a.details["scope"])).toEqual([
      "source",
      "session",
    ]);
    await env.desktop.api.revokeServerMigration({ sessionId: invitation.sessionId });
    expect((await env.desktop.api.getServerMigration({})).session).toBeUndefined();

    // The reservation is gone: the server takes data again, and with data it is no import target.
    await env.server.addWorker("own worker");
    expect(await refusal(env.server.api.createServerMigrationInvitation({}))).toEqual({
      code: Code.FailedPrecondition,
      message: TARGET_NOT_EMPTY,
    });
  });

  test("migration pairing accepts only HTTP/2 over TLS 1.3; phones keep TLS 1.2 elsewhere", async () => {
    const origin = new URL(env.serverNet.network.origins()[0]!);

    const status = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const request = https.request(
          {
            host: origin.hostname,
            port: origin.port,
            path,
            method: "POST",
            maxVersion: "TLSv1.2",
            rejectUnauthorized: false,
            headers: { "content-type": "application/proto" },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );

        request.once("error", reject);
        request.end();
      });

    expect(await status(`/${migration.MigrationPairingService.typeName}/ExchangeMigrationPairing`)).toBe(403);
    expect(await status(`/${ui.MobilePairingService.typeName}/ExchangeMobilePairing`)).not.toBe(403);
  });
});
