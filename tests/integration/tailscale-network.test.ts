import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDirs } from "@canopy/testing";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { requireRemoteWorkerAddress } from "../../apps/gateway/src/core/worker-ssh-command.ts";
import type { DetectedAddress } from "../../apps/gateway/src/network/addresses.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { preferTailnet } from "../../apps/gateway/src/network/tailscale/addresses.ts";
import { parseStatus } from "../../apps/gateway/src/network/tailscale/status.ts";
import { Tailscale } from "../../apps/gateway/src/network/tailscale/tailscale.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually as poll, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { fakeTailscale, statusJson } from "./support/tailscale.ts";

const dirs = tempDirs();
const MAGIC = "laptop.example-tailnet.ts.net";
const LAN: DetectedAddress = { host: "192.168.1.20", kind: "lan", interfaceName: "en0" };
const TAILNET: DetectedAddress = { host: "192.0.2.10", kind: "tailscale", interfaceName: "tailscale0" };
const VPN: DetectedAddress = { host: "10.8.0.2", kind: "vpn", interfaceName: "wg0" };

const update = (action: string, extra: { enabled?: boolean; hostnames?: string[] } = {}) =>
  create(ui.UpdateNetworkAccessRequestSchema, { action, ...extra });

async function eventually(predicate: () => Promise<boolean>, timeoutMs = 8000) {
  expect(await poll(predicate, Boolean, timeoutMs)).toBe(true);
}

/** Detection on the fake CLI only (no LocalAPI sockets): the real Tailscale is never asked. */
const detector = (path: string) => new Tailscale({ path, sockets: [], platform: "linux", pollMs: 60_000 });

describe("tailnet addresses first", () => {
  test("connected: the MagicDNS name, then the tailnet IPv4, then the local network and VPNs", () => {
    const connected = parseStatus(JSON.stringify(statusJson({ dnsName: MAGIC })));

    expect(preferTailnet([LAN, TAILNET, VPN], connected).map((a) => [a.host, a.kind, a.interfaceName])).toEqual([
      [MAGIC, "tailscale", "MagicDNS"],
      ["192.0.2.10", "tailscale", "tailscale0"],
      ["192.168.1.20", "lan", "en0"],
      ["10.8.0.2", "vpn", "wg0"],
    ]);
  });

  test("without MagicDNS the tailnet address leads; without Tailscale nothing changes", () => {
    const plain = parseStatus(JSON.stringify(statusJson({ magicDns: false })));
    expect(preferTailnet([LAN], plain).map((a) => a.host)).toEqual(["192.0.2.10", "192.168.1.20"]);

    const loggedOut = parseStatus(JSON.stringify(statusJson({ backend: "NeedsLogin" })));
    expect(preferTailnet([LAN, TAILNET], loggedOut)).toEqual([LAN, TAILNET]);
    expect(preferTailnet([LAN, TAILNET], undefined)).toEqual([LAN, TAILNET]);
  });

  test("an SSH install on loopback points at the tailnet address", () => {
    expect(() =>
      requireRemoteWorkerAddress("http://127.0.0.1:7443", "192.0.2.40", {
        origin: `https://${MAGIC}:24443`,
        connected: true,
      }),
    ).toThrow(`Set the gateway address for workers to https://${MAGIC}:24443 (Tailscale)`);
    expect(() => requireRemoteWorkerAddress("", "192.0.2.40", { origin: "", connected: true })).toThrow(
      "Turn on network access to reach this computer over Tailscale",
    );
  });
});

describe.skipIf(!dockerAvailable)("tailscale on a gateway", () => {
  let gw: TestGateway;
  let network: NetworkAccess;
  let unmount: () => void;
  const fake = fakeTailscale(dirs("canopy-ts-net-"), "down");
  const tailscale = detector(fake.path);
  let interfaces: DetectedAddress[] = [];

  beforeAll(async () => {
    gw = await startTestGateway();
    await tailscale.start();
    network = new NetworkAccess({
      store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
      role: gw.core.role,
      host: "127.0.0.1",
      detect: () => interfaces,
      tailscale,
      pollMs: 60_000,
    });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
  }, 60_000);

  afterAll(async () => {
    unmount?.();
    tailscale.close();
    await network?.close();
    await gw?.close();
  }, 15_000);

  test("the owner's paired phone reads Tailscale and asks for a new reading", async () => {
    interfaces = [{ host: "127.0.0.1", kind: "lan", interfaceName: "lo-test" }];
    await network.refresh();
    await gw.api.updateNetworkAccess(update("set_enabled", { enabled: true }));

    const transport = nodePinnedTransport();
    const invitation = await gw.api.createMobilePairing({});
    const connection = gw.core.mobile.networkRoutes();

    const paired = await routedMobileClient({ connection, transport }).pairing.exchangeMobilePairing({
      code: invitation.code,
      name: "Tailnet phone",
      platform: "ios",
    });

    fake.setStatus({ dnsName: MAGIC });
    const phone = routedMobileClient({ connection, transport, token: paired.deviceToken }).api;

    expect((await phone.getNetworkAccess({})).fingerprint).toBe(network.fingerprint);

    const owner = await phone.updateNetworkAccess(update("refresh_tailscale"));
    expect(owner.tailscale).toMatchObject({
      state: "connected",
      dnsName: MAGIC,
      ipv4: ["192.0.2.10"],
      ipv6: ["2001:db8::10"],
      magicDns: true,
      httpsCertificates: true,
    });
    expect(fake.calls().every((args) => args.join(" ") === "status --json")).toBe(true);
  }, 30_000);

  test("network access offers the MagicDNS name first, keeps the local network after it and lists a name once", async () => {
    interfaces = [LAN, TAILNET];
    fake.setStatus({ dnsName: MAGIC });
    const status = await gw.api.updateNetworkAccess(update("refresh_tailscale"));
    const port = status.port;

    expect(status.addresses.map((a) => [a.origin, a.kind])).toEqual([
      [`https://${MAGIC}:${port}`, "tailscale"],
      [`https://192.0.2.10:${port}`, "tailscale"],
      [`https://192.168.1.20:${port}`, "lan"],
    ]);

    const named = await gw.api.updateNetworkAccess(
      update("set_hostnames", { hostnames: [MAGIC, "canopy.example.com"] }),
    );

    expect(named.addresses.map((a) => a.host)).toEqual([MAGIC, "192.0.2.10", "192.168.1.20", "canopy.example.com"]);
    await gw.api.updateNetworkAccess(update("set_hostnames", { hostnames: [] }));
  });

  test("the worker address follows the tailnet; a saved address still wins", async () => {
    const port = network.status().port;
    expect((await gw.core.workers.setup()).gatewayUrl).toBe(`https://${MAGIC}:${port}`);
    expect(gw.core.workers.tailnet()).toEqual({ origin: `https://${MAGIC}:${port}`, connected: true });

    const settings = await gw.api.getSettings({});
    await gw.api.updateUserSettings({
      expectedVersion: settings.user!.version,
      workerGatewayUrl: "https://w.example.com",
    });
    expect((await gw.core.workers.setup()).gatewayUrl).toBe("https://w.example.com");
    const reset = await gw.api.getSettings({});
    await gw.api.updateUserSettings({ expectedVersion: reset.user!.version, workerGatewayUrl: "" });
  });

  test("logging out of Tailscale moves the local network back to the front", async () => {
    fake.setStatus({ backend: "NeedsLogin" });
    const status = await gw.api.updateNetworkAccess(update("refresh_tailscale"));

    expect(status.tailscale).toMatchObject({ state: "logged_out", dnsName: "", ipv4: [] });
    expect(status.addresses.map((a) => a.host)).toEqual(["192.168.1.20", "192.0.2.10"]);
    expect(gw.core.workers.tailnet()).toEqual({ origin: `https://192.0.2.10:${status.port}`, connected: false });
  });
});

describe.skipIf(!dockerAvailable)("two linked gateways on a tailnet", () => {
  let a: TestGateway;
  let b: TestGateway;
  let la: LinkedComputers;
  let lb: LinkedComputers;
  const fake = fakeTailscale(dirs("canopy-ts-link-"), { dnsName: "desk.example-tailnet.ts.net", ips: ["192.0.2.20"] });
  const tailscale = detector(fake.path);

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });
    await tailscale.start();
    la = linkedComputers({ store: new ComputerStore(a.runtime, a.userId, a.secretsKey), host: "127.0.0.1" });
    lb = linkedComputers({
      store: new ComputerStore(b.runtime, b.userId, b.secretsKey),
      host: "127.0.0.1",
      detect: () => [{ host: "127.0.0.1", kind: "lan", interfaceName: "lo-test" }],
      tailscale,
    });
    a.core.computers = la;
    a.core.network = la.options.network;
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await la.start();
    await lb.start();
  }, 60_000);

  afterAll(async () => {
    tailscale.close();
    await Promise.allSettled([la?.close(), lb?.close()]);
    await a?.close();
    await b?.close();
  }, 15_000);

  test("a computer announces its MagicDNS name first and its partner keeps it as a pinned route", async () => {
    const port = lb.options.network.status().port;
    expect(lb.hello().addresses).toEqual([
      `https://desk.example-tailnet.ts.net:${port}`,
      `https://192.0.2.20:${port}`,
      `https://127.0.0.1:${port}`,
    ]);

    const pairing = await a.api.createComputerPairing({});
    await b.api.linkComputer({ address: la.addresses[0]!, code: pairing.code });

    await eventually(async () =>
      Boolean(
        (await a.api.getComputers({})).peers[0]?.routes.some(
          (r) => r.address === `https://desk.example-tailnet.ts.net:${port}` && r.source === "announced",
        ),
      ),
    );
    await eventually(async () => (await a.api.getComputers({})).peers[0]?.status === "connected", 15_000);
  }, 30_000);
});
