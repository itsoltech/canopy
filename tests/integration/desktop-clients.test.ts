import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

  beforeAll(async () => {
    gw = await startTestGateway();
    network = new NetworkAccess({ store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey), host: "127.0.0.1" });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
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

    expect(await failure(api(phone.deviceToken).createDesktopPairing({}))).toContain("web Settings");
    expect(await failure(api(phone.deviceToken).getNetworkAccess({}))).toContain("web Settings");
    expect(await failure(api(phone.deviceToken).createWorkerEnrollment({ name: "Escalation" }))).toContain(
      "web Settings",
    );
    expect(await failure(api(phone.deviceToken).rotateWorkerCredential({ workerId: gw.workerId }))).toContain(
      "web Settings",
    );
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

    const ended = (async () => {
      while (!(await watch.next()).done) {
        /* drain */
      }
    })();

    await gw.api.revokeMobileDevice({ id: client.deviceId });
    await ended;
    expect(await failure(desktop.getSettings({}))).toContain("revoked");
    expect(
      (await query("SELECT action FROM audit_log WHERE target_id = $1", [client.deviceId])).map((r) => r["action"]),
    ).toContain("desktop.device.revoke");
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

  test("automatic migration requires an owned desktop worker, mints only over Network access, and cannot bypass revoke", async () => {
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
    const paired = await migrate(gw.workerCredential);
    expect((await api(paired.deviceToken).getSettings({})).user).toBeDefined();
    await gw.api.revokeMobileDevice({ id: paired.device!.id });
    expect(await failure(migrate(gw.workerCredential))).toContain("migration unavailable");
    expect(
      (await query("SELECT action FROM audit_log WHERE target_id = $1", [paired.device!.id])).map((r) => r["action"]),
    ).toContain("desktop.migrate");
  });
});
