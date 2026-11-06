import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { AsyncChannel } from "@canopy/transport";
import { computerLink as link } from "@canopy/contracts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { startComputerLinks } from "../../apps/gateway/src/computers/start.ts";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { linkClient } from "../../apps/gateway/src/computers/transport.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { desktopGateway } from "../../apps/web/src/lib/server/desktop-gateway.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { pairDesktop } from "../../apps/desktop/src/remote-client.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { DESKTOP_LINKS_ONLY, gatewayRole } from "../../apps/gateway/src/role.ts";
import { SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

// Bun's async rejects matcher can stall Connect calls; settle the RPC before asserting.
const rejected = (call: Promise<unknown>) => call.catch((cause: unknown) => ConnectError.from(cause));

describe.skipIf(!dockerAvailable)("server gateways exclude computer links", () => {
  let gw: TestGateway;
  let store: ComputerStore;
  let network: NetworkAccess;
  let unmount: () => void;

  beforeAll(async () => {
    gw = await startTestGateway({ role: gatewayRole({}) });
    store = new ComputerStore(gw.runtime, gw.userId, gw.secretsKey);
    network = new NetworkAccess({ store, role: gw.core.role, host: "127.0.0.1" });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await startComputerLinks(gw.core, store, network, undefined);
    await network.start();
    await gw.api.updateNetworkAccess({ action: "set_enabled", enabled: true });
  }, 60_000);

  afterAll(async () => {
    unmount?.();
    await network?.close();
    await gw?.close();
  });

  test("startup reports server capability and every linking RPC fails with a desktop-only reason", async () => {
    expect(gw.core.computers).toBeUndefined();
    expect(await gw.api.getClientCapabilities({})).toMatchObject({ gatewayRole: "server", linkedComputers: false });

    const operations = [
      () => gw.api.getComputers({}),
      () => gw.api.createComputerPairing({}),
      () => gw.api.linkComputer({ address: "https://127.0.0.1:1", code: "invalid" }),
      () => gw.api.manageComputer({ action: "lan_discovery", enabled: true }),
      () => gw.api.getSharedConfig({}),
      () => gw.api.manageSharedConfig({ action: "share", key: "settings:appearance" }),
      () => gw.api.previewMove({}),
      () => gw.api.startMove({}),
      () => gw.api.getMoves({}),
    ];

    for (const operation of operations)
      expect(await rejected(operation())).toMatchObject({
        code: Code.FailedPrecondition,
        rawMessage: DESKTOP_LINKS_ONLY,
      });
  });

  test("Pair and Connect with a computer certificate are rejected on the shared listener", async () => {
    const identity = await generateIdentity();
    const client = linkClient(network.origins()[0]!, (await store.identity()).certificate, identity);
    expect(await rejected(client.pair({}, { timeoutMs: 3000 }))).toMatchObject({ code: Code.PermissionDenied });
    const frames = new AsyncChannel<link.LinkFrame>();
    frames.push(create(link.LinkFrameSchema, { body: { case: "hello", value: { nodeId: identity.nodeId } } }));

    try {
      const response = client.connect(frames, { timeoutMs: 3000 });
      expect(await rejected(response[Symbol.asyncIterator]().next())).toMatchObject({ code: Code.PermissionDenied });
      expect(await store.peers()).toHaveLength(0);
    } finally {
      frames.close();
    }
  });

  test("phones still pair and read their owner's overview over the same TLS listener", async () => {
    const transport = nodePinnedTransport();
    const connection = gw.core.mobile.networkRoutes();
    const invitation = await gw.api.createMobilePairing({});

    const paired = await routedMobileClient({ connection, transport }).pairing.exchangeMobilePairing({
      code: invitation.code,
      name: "Server phone",
      platform: "ios",
    });

    const phone = routedMobileClient({ connection, transport, token: paired.deviceToken }).api;
    expect((await phone.getOverview({})).workers.some((w) => w.id === gw.workerId)).toBe(true);
    expect(await rejected(phone.createComputerPairing({}))).toMatchObject({ code: Code.FailedPrecondition });
  });

  test("a paired desktop's local BFF reports the server's disabled linking capability", async () => {
    const invitation = await gw.api.createDesktopPairing({});
    const paired = await pairDesktop(toJsonString(ui.CreateMobilePairingResponseSchema, invitation));

    const bff = desktopGateway(
      JSON.stringify({ fingerprint: paired.fingerprint, addresses: paired.addresses }),
      paired.token,
    );

    expect(await bff.compatibility()).toMatchObject({ state: "ready", gatewayRole: "server", linkedComputers: false });
    const desktop = createClient(ui.GatewayService, bff.transport);
    expect((await desktop.getOverview({})).workers.some((w) => w.id === gw.workerId)).toBe(true);
    expect(await rejected(desktop.getComputers({}))).toMatchObject({
      code: Code.FailedPrecondition,
      rawMessage: DESKTOP_LINKS_ONLY,
    });
  });

  test("old links become inactive without deleting trust, routes or mirrors and without exposing them", async () => {
    const peer = await generateIdentity();
    await store.remember(
      create(link.NodeHelloSchema, { nodeId: peer.nodeId, name: "Old desktop", minProtocol: 1, maxProtocol: 1 }),
      peer.certificate,
      "https://127.0.0.1:1",
      1,
    );
    await store.status(peer.nodeId, "connected");
    const otherOwner = crypto.randomUUID();
    await store.query("INSERT INTO users(id,email,display_name,role) VALUES ($1::uuid,$2,'Other owner','user')", [
      otherOwner,
      `${otherOwner}@localhost`,
    ]);
    await store.query(
      `INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint,status)
       VALUES ($1::uuid,$2,'Other owner desktop',$3,$4,'connected')`,
      [otherOwner, peer.nodeId, peer.certificate, peer.fingerprint],
    );
    await store.query(
      `INSERT INTO computer_mirror_state(owner_user_id,origin_node_id,cursor,generation)
       VALUES ($1::uuid,$2,'kept',$3::uuid)`,
      [gw.userId, peer.nodeId, crypto.randomUUID()],
    );
    await startComputerLinks(gw.core, store, network, undefined);
    expect(gw.core.computers).toBeUndefined();
    expect((await store.peer(peer.nodeId))?.status).toBe("inactive");
    expect((await store.peer(peer.nodeId))?.certificate).toBe(peer.certificate);
    expect((await store.peer(peer.nodeId))?.addresses).toEqual(["https://127.0.0.1:1"]);
    expect(
      (
        await store.query<{ status: string }>("SELECT status FROM computer_peers WHERE owner_user_id=$1::uuid", [
          otherOwner,
        ])
      )[0]?.status,
    ).toBe("connected");
    expect(
      (
        await store.query<{ cursor: string }>("SELECT cursor FROM computer_mirror_state WHERE owner_user_id=$1::uuid", [
          gw.userId,
        ])
      )[0]?.cursor,
    ).toBe("kept");
    expect((await gw.api.getOverview({})).computers).toHaveLength(0);
  });
});
