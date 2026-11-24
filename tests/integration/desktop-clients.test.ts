import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { create, toJsonString } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { routedPinnedTransport } from "@canopy/transport";
import { Effect } from "effect";
import { SqlClient, type SqlConnection } from "effect/sql";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { openListener } from "../../apps/gateway/src/network/listener.ts";
import { pairDesktop } from "../../apps/desktop/src/remote-client.ts";
import { configuration } from "../../apps/desktop/src/runtime/config.ts";
import { SERVICE_TOKEN, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("desktop client: owner-scoped pairing and pinned UI gRPC", () => {
  let gw: TestGateway;
  let network: NetworkAccess;
  let unmount: () => void;

  const query = (text: string, params: unknown[] = []) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<SqlConnection.Row>(text, params);
      }),
    );

  const routes = () => gw.core.mobile.networkRoutes();
  const api = (token: string) => createClient(ui.GatewayService, routedPinnedTransport(routes(), token).transport);
  const invite = () => gw.api.createDesktopPairing({});
  const pair = async () => pairDesktop(toJsonString(ui.CreateMobilePairingResponseSchema, await invite()));

  const migrate = (token: string, workerId = gw.workerId) =>
    createClient(ui.DesktopMigrationService, routedPinnedTransport(routes(), token).transport).migrateDesktopClient({
      workerId,
      platform: "linux",
    });

  async function openNetwork() {
    network = new NetworkAccess({ store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey), host: "127.0.0.1" });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
  }

  beforeAll(async () => {
    gw = await startTestGateway();
    await openNetwork();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
  }, 60_000);
  afterAll(async () => {
    unmount?.();
    await network?.close();
    await gw?.close();
  });

  test("desktop exchanges once, has full UI scope and is listed/audited without plaintext secrets", async () => {
    const invitation = await invite();

    const text = toJsonString(ui.CreateMobilePairingResponseSchema, invitation).replace(
      /}$/,
      ',"futureCapability":true}',
    );

    const config = configuration({ mode: "remote", gatewayUrl: "", pairingInvitation: text });
    expect(config.mode === "remote" && config.gatewayUrl === invitation.routes!.addresses[0]).toBe(true);
    const results = await Promise.allSettled([pairDesktop(text), pairDesktop(text)]);
    const clients = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(clients).toHaveLength(1);
    const client = clients[0]!;
    const desktop = api(client.token);
    expect((await desktop.getOverview({})).workers.some((w) => w.id === gw.workerId)).toBe(true);
    expect((await desktop.getNetworkAccess({})).enabled).toBe(true);
    expect((await desktop.getMobileDevices({})).devices.find((d) => d.id === client.deviceId)?.clientKind).toBe(
      "desktop",
    );
    expect((await desktop.createDesktopPairing({})).code).not.toBe("");
    const rows = await query("SELECT token_hash, owner_user_id FROM mobile_devices WHERE id = $1", [client.deviceId]);
    expect(rows[0]?.["token_hash"]).toBe(createHash("sha256").update(client.token).digest("hex"));
    expect(rows[0]?.["owner_user_id"]).toBe(gw.userId);
    expect(
      (await query("SELECT action FROM audit_log WHERE target_id = $1 ORDER BY created_at", [client.deviceId])).map(
        (r) => r["action"],
      ),
    ).toContain("desktop.pair");
    expect(await failure(pairDesktop(text))).toContain("already used");
  });

  test("new and replacement desktop pairings stay unseen until the client uses its credential", async () => {
    async function pairAndConnect() {
      const invitation = await invite();
      const client = await pairDesktop(toJsonString(ui.CreateMobilePairingResponseSchema, invitation));
      const devices = await gw.api.getMobileDevices({});
      const accepted = devices.pairings.find((entry) => entry.id === invitation.pairing?.id);
      expect(accepted?.usedAt).toBeDefined();
      expect(accepted?.deviceId === client.deviceId).toBe(true);
      const paired = devices.devices.find((entry) => entry.id === client.deviceId);
      expect(paired?.clientKind).toBe("desktop");
      expect(paired?.lastSeenAt).toBeUndefined();

      const watch = gw.api
        .watchOverview({ includeSnapshot: true }, { signal: AbortSignal.timeout(5000) })
        [Symbol.asyncIterator]();

      try {
        expect((await watch.next()).done).toBe(false);
        expect(await api(client.token).getClientCapabilities({})).toMatchObject({
          gatewayRole: "server",
          linkedComputers: false,
        });

        let firstSeen: ui.MobileDevice["lastSeenAt"];

        for (let next = await watch.next(); !next.done; next = await watch.next()) {
          const { change } = next.value;

          if (change.case === "mobileDevice" && change.value.id === client.deviceId && change.value.lastSeenAt) {
            firstSeen = change.value.lastSeenAt;
            break;
          }
        }

        const connected = (await gw.api.getMobileDevices({})).devices.find((entry) => entry.id === client.deviceId);
        expect(firstSeen).toBeDefined();
        expect(connected?.lastSeenAt).toEqual(firstSeen);
      } finally {
        await watch.return?.();
      }

      return client;
    }

    const original = await pairAndConnect();
    await gw.api.revokeMobileDevice({ id: original.deviceId });
    const replacement = await pairAndConnect();
    expect(replacement.deviceId !== original.deviceId).toBe(true);
    expect(await failure(api(original.token).getClientCapabilities({}))).toContain("revoked");
  });

  test("phone codes cannot grant desktop scope, desktop codes cannot be used by phones", async () => {
    const mobile = await gw.api.createMobilePairing({});
    const transport = routedPinnedTransport(routes()).transport;
    expect(
      await failure(
        createClient(ui.DesktopPairingService, transport).exchangeDesktopPairing({
          code: mobile.code,
          name: "Escalation",
          platform: "linux",
        }),
      ),
    ).toContain("invalid");
    const desktop = await invite();
    expect(
      await failure(
        createClient(ui.MobilePairingService, transport).exchangeMobilePairing({
          code: desktop.code,
          name: "Phone",
          platform: "ios",
        }),
      ),
    ).toContain("invalid");

    const phone = await createClient(ui.MobilePairingService, transport).exchangeMobilePairing({
      code: mobile.code,
      name: "Phone",
      platform: "ios",
    });

    const phoneApi = api(phone.deviceToken);
    const desktopInvite = await phoneApi.createDesktopPairing({});
    expect(desktopInvite.pairing?.clientKind).toBe("desktop");
    await phoneApi.revokeMobilePairing({ id: desktopInvite.pairing!.id });
    expect((await phoneApi.getNetworkAccess({})).enabled).toBe(true);
    const enrollment = await phoneApi.createWorkerEnrollment({ name: "Owner setup" });
    await phoneApi.revokeWorkerEnrollment({ id: enrollment.enrollment!.id });
    expect(await failure(phoneApi.rotateWorkerCredential({ workerId: Bun.randomUUIDv7() }))).toContain("not found");
  });

  test("foreign-owner tokens and objects are inaccessible; revoke closes streams and rejects further access", async () => {
    const client = await pair();
    const desktop = api(client.token);
    const foreign = Bun.randomUUIDv7();
    await query("INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'Other', 'user')", [
      foreign,
      `${foreign}@test.invalid`,
    ]);
    const project = Bun.randomUUIDv7();
    await query("INSERT INTO projects (id, owner_user_id, name, slug) VALUES ($1::uuid, $2::uuid, 'Private', $3)", [
      project,
      foreign,
      project,
    ]);
    expect((await desktop.getOverview({})).projects.some((p) => p.id === project)).toBe(false);
    expect(await failure(desktop.renameProject({ projectId: project, name: "Stolen" }))).toContain("not found");
    await query("UPDATE mobile_devices SET owner_user_id = $1 WHERE id = $2", [foreign, client.deviceId]);
    expect(await failure(desktop.getOverview({}))).toContain("revoked");
    expect(await failure(gw.api.revokeMobileDevice({ id: client.deviceId }))).toContain("not found");
    await query("UPDATE mobile_devices SET owner_user_id = $1 WHERE id = $2", [gw.userId, client.deviceId]);

    const watch = desktop
      .watchOverview({ includeSnapshot: true }, { signal: AbortSignal.timeout(5000) })
      [Symbol.asyncIterator]();

    expect((await watch.next()).done).toBe(false);

    const ended = failure(
      (async () => {
        while (!(await watch.next()).done) {
          /* drain */
        }
      })(),
    );

    await gw.api.revokeMobileDevice({ id: client.deviceId });
    expect(await ended).toContain("Device revoked");
    expect(await failure(desktop.getSettings({}))).toContain("revoked");
    expect(
      (await query("SELECT action FROM audit_log WHERE target_id = $1", [client.deviceId])).map((r) => r["action"]),
    ).toContain("desktop.device.revoke");
  });

  test("revocation suppresses a snapshot already being prepared", async () => {
    const client = await pair();
    const preparing = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    const overview = gw.core.overview.bind(gw.core);

    const snapshot = spyOn(gw.core, "overview").mockImplementation(async () => {
      const value = await overview();
      preparing.resolve();
      await ready.promise;

      return value;
    });

    const watch = api(client.token).watchOverview({ includeSnapshot: true }, { signal: AbortSignal.timeout(5000) });

    const received = failure(
      (async () => {
        for await (const update of watch) expect(update.change.case).not.toBe("mobileSnapshot");
      })(),
    );

    try {
      await Promise.race([
        preparing.promise,
        received.then((reason) => {
          throw new Error(reason);
        }),
      ]);
      await gw.api.revokeMobileDevice({ id: client.deviceId });
      ready.resolve();
      expect(await received).toContain("Device revoked");
    } finally {
      ready.resolve();
      await received;
      snapshot.mockRestore();
    }
  });

  test("only the Network access listener accepts an authorized device token", async () => {
    const client = await pair();
    const desktop = api(client.token);
    const processPort = createClient(ui.GatewayService, createGrpcTransport({ baseUrl: gw.grpcUrl }));
    const bearer = { headers: { authorization: `Bearer ${client.token}` } };
    const access = (enabled: boolean) => gw.api.updateNetworkAccess({ action: "set_enabled", enabled });

    expect((await desktop.getSettings({})).user).toBeDefined();
    expect(await failure(processPort.getSettings({}, bearer))).toContain("token");
    await access(false);

    try {
      expect(await failure(desktop.getSettings({}, { timeoutMs: 2000 }))).not.toBe("");
      expect(await failure(processPort.getSettings({}, bearer))).toContain("token");
      expect((await gw.api.getNetworkAccess({})).enabled).toBe(false);
    } finally {
      await access(true);
    }

    expect((await api(client.token).getSettings({})).user).toBeDefined();
  });

  test("wrong pins never send a pairing code or bearer; false routes fall back before HTTP", async () => {
    let requests = 0;

    const falseRoute = await openListener({
      host: "127.0.0.1",
      port: 0,
      identity: await generateIdentity(),
      route: () => (_req, res) => {
        requests++;
        res.end();
      },
    });

    try {
      const invitation = await invite();
      invitation.routes!.fingerprint = "0".repeat(64);
      expect(await failure(pairDesktop(toJsonString(ui.CreateMobilePairingResponseSchema, invitation)))).toContain(
        "pinned TLS",
      );
      invitation.routes!.fingerprint = network.fingerprint;
      invitation.routes!.addresses.unshift(`https://127.0.0.1:${falseRoute.port}`);
      const client = await pairDesktop(toJsonString(ui.CreateMobilePairingResponseSchema, invitation));

      const routed = routedPinnedTransport(
        { ...routes(), addresses: [`https://127.0.0.1:${falseRoute.port}`, ...routes().addresses] },
        client.token,
      );

      expect((await createClient(ui.GatewayService, routed.transport).getOverview({})).workers.length).toBeGreaterThan(
        0,
      );
      expect(requests).toBe(0);
      const before = routed.connection().fingerprint;
      routed.update({ fingerprint: "f".repeat(64), addresses: ["https://attacker.invalid"] });
      expect(routed.connection().fingerprint).toBe(before);
      expect(routed.connection().addresses).not.toContain("https://attacker.invalid");
    } finally {
      await falseRoute.close();
    }
  });

  test("a verified route is reused without a TLS probe per call and replaced after it fails", async () => {
    const real = new URL(routes().addresses[0]!);
    const sockets = new Set<Socket>();
    let connections = 0;

    // Counts every TCP connection to the route: each TLS probe and each HTTP/2 session.
    const relay = createServer((socket) => {
      connections++;
      const upstream = connect(Number(real.port), real.hostname);
      sockets.add(socket).add(upstream);
      socket.pipe(upstream).pipe(socket);

      for (const side of [socket, upstream])
        side.on("error", () => {}).on("close", () => (socket.destroy(), upstream.destroy()));
    });

    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const port = (relay.address() as AddressInfo).port;

    try {
      const client = await pair();
      const routed = routedPinnedTransport({ ...routes(), addresses: [`https://127.0.0.1:${port}`] }, client.token);
      const api = createClient(ui.GatewayService, routed.transport);

      for (let call = 0; call < 5; call++) await api.getOverview({});
      expect(connections).toBe(2);

      // The route dies: one call fails on it, the next one probes again and moves to a reachable route.
      relay.close();

      for (const socket of sockets) socket.destroy();
      routed.update({ fingerprint: network.fingerprint, addresses: [real.origin] });
      expect(await failure(api.getOverview({}))).not.toBe("");
      expect((await api.getOverview({})).workers.length).toBeGreaterThan(0);
      expect(routed.connection().lastAddress).toBe(real.origin);
    } finally {
      relay.close();

      for (const socket of sockets) socket.destroy();
    }
  });

  test("legacy desktop workers can discover routes, while only owner pairing issues a device token", async () => {
    expect(await failure(migrate(gw.workerCredential))).toContain("migration unavailable");
    await query(
      'UPDATE workers SET capabilities = capabilities || \'{"update":{"installKind":"desktop"}}\'::jsonb WHERE id = $1',
      [gw.workerId],
    );
    const legacy = createClient(ui.DesktopMigrationService, createGrpcTransport({ baseUrl: gw.grpcUrl }));
    const options = { headers: { authorization: `Bearer ${gw.workerCredential}` } };
    expect((await legacy.getDesktopMigrationRoutes({ workerId: gw.workerId }, options)).fingerprint).toBe(
      network.fingerprint,
    );
    expect(await failure(legacy.migrateDesktopClient({ workerId: gw.workerId, platform: "linux" }, options))).toContain(
      "not implemented",
    );
    expect(await failure(migrate("not-a-worker-credential"))).toContain("migration unavailable");
    const other = await gw.addWorker("Other worker");
    expect(await failure(migrate(gw.workerCredential, other.workerId))).toContain("migration unavailable");
    expect(await failure(migrate(gw.workerCredential))).toContain("migration unavailable");
    expect(await query("SELECT device_id FROM desktop_worker_migrations WHERE worker_id = $1", [gw.workerId])).toEqual(
      [],
    );
    const paired = await pair();
    expect((await api(paired.token).getSettings({})).user).toBeDefined();
    expect(
      (await query("SELECT action FROM audit_log WHERE target_id = $1", [paired.deviceId])).map((r) => r["action"]),
    ).toContain("desktop.pair");
  });

  test("restart reuses stored owner, worker, desktop and phone authorization and preserves revocation", async () => {
    const desktop = await pair();
    const revoked = await pair();
    const phoneInvite = await gw.api.createMobilePairing({});

    const phone = await createClient(
      ui.MobilePairingService,
      routedPinnedTransport(routes()).transport,
    ).exchangeMobilePairing({ code: phoneInvite.code, name: "Fixture phone", platform: "ios" });

    // A device with the legacy migration provenance is still an ordinary device for authentication.
    await query("INSERT INTO desktop_worker_migrations(worker_id, device_id) VALUES ($1, $2)", [
      gw.workerId,
      desktop.deviceId,
    ]);
    await gw.api.revokeMobileDevice({ id: revoked.deviceId });
    const fingerprint = routes().fingerprint;
    const original = gw;
    unmount();
    await network.close();
    await original.close(true);
    gw = await startTestGateway({ storage: original });
    await openNetwork();

    const overview = await gw.api.getOverview({});
    expect(routes().fingerprint).toBe(fingerprint);
    expect(overview.workers.some((worker) => worker.id === original.workerId && worker.online)).toBe(true);
    expect((await api(desktop.token).getSettings({})).user).toBeDefined();
    expect((await api(phone.deviceToken).getSettings({})).user).toBeDefined();
    expect(await failure(api(revoked.token).getSettings({}))).toContain("revoked");
  }, 60_000);
});
