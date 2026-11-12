import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { computerLink as link } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { CONFIG_SYNC, MOVE_ITEMS, REMOTE_APP_UPDATE, REMOTE_THREAD_PANEL } from "@canopy/domain/computers";
import { AsyncChannel } from "@canopy/transport";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { startComputerLinks } from "../../apps/gateway/src/computers/start.ts";
import { linkClient } from "../../apps/gateway/src/computers/transport.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

/** Use the desktop startup path: lean link fixtures omit production capabilities. */
async function desktop(storage?: TestGateway, legacy = false) {
  const gateway = await startTestGateway({ role: "desktop", ...(storage && { storage }) });
  const store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
  const network = new NetworkAccess({ role: "desktop", store, host: "127.0.0.1" });
  gateway.core.network = network;

  if (legacy) {
    const validate = store.validateHello.bind(store);
    // The nightly.133 decoder ignores field 8; its identity validator rejects field 7 above 32.
    store.validateHello = (hello, nodeId) => {
      if (hello.capabilities.length > 32) throw new ConnectError("Invalid computer identity", Code.Unauthenticated);

      return validate(create(link.NodeHelloSchema, { ...hello, additionalCapabilities: [] }), nodeId);
    };
  }

  await startComputerLinks(gateway.core, store, network, undefined);
  const computers = gateway.core.computers!;

  if (legacy) {
    const hello = computers.hello.bind(computers);
    computers.hello = () =>
      create(link.NodeHelloSchema, {
        ...hello(),
        appVersion: "0.2.0-nightly.133",
        capabilities: hello().capabilities.slice(0, 32),
      });
  }

  await network.start();
  await gateway.api.updateNetworkAccess({ action: "set_enabled", enabled: true });

  return {
    gateway,
    store,
    computers,
    async close(keepDatabase = false) {
      await computers.close();
      await network.close();
      await gateway.close(keepDatabase);
    },
  };
}

describe.skipIf(!dockerAvailable)("production desktop capability compatibility", () => {
  let a: Awaited<ReturnType<typeof desktop>>;
  let b: Awaited<ReturnType<typeof desktop>>;

  async function online() {
    expect(
      await eventually(
        async () =>
          (await a.store.peers())[0]?.status === "connected" && (await b.store.peers())[0]?.status === "connected",
        Boolean,
        15_000,
      ),
    ).toBe(true);
  }

  beforeAll(async () => {
    a = await desktop();
    b = await desktop();
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([a?.close(), b?.close()]);
  }, 15_000);

  test("complete production hellos pair and retain all capabilities and pins across both gateway restarts", async () => {
    expect(a.computers.hello().capabilities.length).toBeGreaterThan(32);
    expect(b.computers.hello().capabilities.length).toBeGreaterThan(32);
    const invitation = await a.gateway.api.createComputerPairing({});
    await b.gateway.api.linkComputer({ address: a.computers.addresses[0]!, code: invitation.code });
    await online();
    const identities = [await a.store.identity(), await b.store.identity()];
    const capabilities = a.computers.hello().capabilities;

    for (const peer of [(await a.store.peers())[0]!, (await b.store.peers())[0]!])
      expect(peer.capabilities).toEqual(capabilities);

    await Promise.all([a.close(true), b.close(true)]);
    a = await desktop(a.gateway);
    b = await desktop(b.gateway);
    await online();
    expect((await a.store.identity()).certificate).toBe(identities[0]!.certificate);
    expect((await b.store.identity()).certificate).toBe(identities[1]!.certificate);
    expect((await a.store.peers())[0]!.certificate).toBe(identities[1]!.certificate);
    expect((await b.store.peers())[0]!.certificate).toBe(identities[0]!.certificate);
    expect(a.computers.capabilities(b.computers.hello().nodeId)).toEqual(capabilities);
    expect(b.computers.capabilities(a.computers.hello().nodeId)).toEqual(capabilities);
  }, 60_000);

  test("unfixed nightly.137 can send 33 in the old field; malformed overflow cannot change trust", async () => {
    const client = linkClient(a.computers.addresses[0]!, a.computers.identity.certificate, b.computers.identity);
    const hello = b.computers.hello();
    const invitation = await a.gateway.api.createComputerPairing({});
    const raw = invitation.code.replaceAll("-", "");
    // Reproduce the old sender without wireHello: all 33 entries occupy field 7.
    const paired = await client.pair({ secret: raw.slice(64), hello });
    expect(paired.hello!.capabilities).toHaveLength(32);
    expect(paired.hello!.additionalCapabilities).toContain(REMOTE_THREAD_PANEL);
    const frames = new AsyncChannel<link.LinkFrame>();
    frames.push(create(link.LinkFrameSchema, { body: { case: "hello", value: hello } }));
    const abort = new AbortController();

    try {
      const stream = client.connect(frames, { signal: abort.signal, timeoutMs: 5000 });
      const response = await stream[Symbol.asyncIterator]().next();
      expect(response.value?.body.case).toBe("welcome");
      expect((await a.store.peers())[0]!.capabilities).toEqual(hello.capabilities);
    } finally {
      abort.abort();
      frames.close();
    }

    const pin = (await a.store.peers())[0]!.certificate;
    const overflow = create(link.NodeHelloSchema, {
      ...hello,
      capabilities: hello.capabilities.slice(0, 32),
      additionalCapabilities: Array.from({ length: 97 }, () => "extra_feature"),
    });
    const error = await client
      .pair({ secret: raw.slice(64), hello: overflow })
      .catch((cause: unknown) => ConnectError.from(cause));
    expect(error).toBeInstanceOf(ConnectError);
    expect(error).toMatchObject({ code: Code.InvalidArgument, rawMessage: "Too many computer capabilities" });
    expect((await a.store.peers())[0]!.certificate).toBe(pin);
    expect((await a.store.peers())[0]!.capabilities).toEqual(hello.capabilities);
  }, 25_000);

  test("nightly.133's real 32-entry guard accepts pairing, welcome and renamed hellos without dropping old features", async () => {
    await Promise.all([a.close(true), b.close(true)]);
    b = await desktop(b.gateway, true);
    a = await desktop(a.gateway);
    const invitation = await b.gateway.api.createComputerPairing({});
    await a.gateway.api.linkComputer({ address: b.computers.addresses[0]!, code: invitation.code });
    await online();
    const reverse = await a.gateway.api.createComputerPairing({});
    await b.gateway.api.linkComputer({ address: a.computers.addresses[0]!, code: reverse.code });
    await online();
    await a.gateway.api.manageComputer({ action: "rename", name: "Updated desktop" });
    await b.gateway.api.manageComputer({ action: "rename", name: "Older desktop" });
    expect(await eventually(async () => (await b.store.peers())[0]?.name === "Updated desktop", Boolean, 5000)).toBe(
      true,
    );
    await online();

    for (const peer of [(await a.store.peers())[0]!, (await b.store.peers())[0]!]) {
      expect(peer.capabilities).toHaveLength(32);
      expect(peer.capabilities).toContain(CONFIG_SYNC);
      expect(peer.capabilities).toContain(MOVE_ITEMS);
      expect(peer.capabilities).toContain(REMOTE_APP_UPDATE);
      expect(peer.capabilities).not.toContain(REMOTE_THREAD_PANEL);
    }
  }, 60_000);
});
