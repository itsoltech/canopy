import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { classify, hostnameEntry } from "../../apps/gateway/src/network/addresses.ts";
import { localNetworkBlocked } from "../../apps/gateway/src/network/local-network.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { networkPort } from "../../apps/gateway/src/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually as poll, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

async function eventually(predicate: () => Promise<boolean>, timeoutMs = 8000) {
  expect(await poll(predicate, Boolean, timeoutMs)).toBe(true);
}

/** Whether something accepts TCP connections on the port. */
function open(port: number, host = "127.0.0.1") {
  return new Promise<boolean>((resolve) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
    socket.setTimeout(2000, () => socket.destroy());
    socket.once("secureConnect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("close", () => resolve(false));
  });
}

async function occupy(): Promise<Server & { port: number }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "::", resolve));

  return Object.assign(server, { port: (server.address() as AddressInfo).port });
}

const update = (action: string, extra: { enabled?: boolean; port?: number; hostnames?: string[] } = {}) =>
  create(ui.UpdateNetworkAccessRequestSchema, { action, ...extra });

describe("network addresses", () => {
  test("only addresses other devices can use are offered, each with its kind", () => {
    expect(classify("192.168.1.20", "en0")).toBe("lan");
    expect(classify("100.101.2.3", "tailscale0")).toBe("tailscale");
    expect(classify("100.101.2.3", "utun4")).toBe("tailscale");
    expect(classify("10.8.0.2", "wg0")).toBe("vpn");
    expect(classify("172.17.0.1", "docker0")).toBeUndefined();
    expect(classify("169.254.10.1", "en0")).toBeUndefined();
    expect(classify("203.0.113.7", "eth0")).toBe("public");
  });

  test("hostnames are normalized; ports, paths and schemes are checked", () => {
    expect(hostnameEntry(" Laptop.Tailnet.ts.net ")).toBe("laptop.tailnet.ts.net");
    expect(hostnameEntry("canopy.example.com:8443")).toBe("canopy.example.com:8443");
    expect(hostnameEntry("[fd7a:115c:a1e0::1]:443")).toBe("[fd7a:115c:a1e0::1]:443");

    for (const bad of ["https://x.example", "x.example/path", "bad host", "x.example:70000", "1.2.3"])
      expect(() => hostnameEntry(bad)).toThrow("isn't a hostname");
  });

  test("macOS local network denial is told apart from an unreachable computer", () => {
    const lan = [{ host: "192.168.1.20", kind: "lan" as const, interfaceName: "en0" }];
    expect(localNetworkBlocked("192.168.1.30", "EHOSTUNREACH", lan, "darwin")).toBe(true);
    expect(localNetworkBlocked("192.168.1.30", "EHOSTUNREACH", lan, "linux")).toBe(false);
    expect(localNetworkBlocked("10.0.0.5", "EHOSTUNREACH", lan, "darwin")).toBe(false);
    expect(localNetworkBlocked("192.168.1.30", "ECONNREFUSED", lan, "darwin")).toBe(false);
  });

  test("a server environment port must be a real port", () => {
    expect(networkPort({})).toBeUndefined();
    expect(networkPort({ CANOPY_NETWORK_PORT: "24443" })).toBe(24443);
    expect(() => networkPort({ CANOPY_NETWORK_PORT: "http" })).toThrow("CANOPY_NETWORK_PORT");
  });
});

describe.skipIf(!dockerAvailable)("network access on a gateway", () => {
  let gw: TestGateway;
  let store: ComputerStore;
  const started: NetworkAccess[] = [];

  async function network(options: Partial<ConstructorParameters<typeof NetworkAccess>[0]> = {}) {
    const access = new NetworkAccess({ store, host: "127.0.0.1", pollMs: 100, ...options });
    started.push(access);
    await access.start();

    return access;
  }

  beforeAll(async () => {
    gw = await startTestGateway();
    store = new ComputerStore(gw.runtime, gw.userId, gw.secretsKey);
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled(started.map((n) => n.close()));
    await gw?.close();
  }, 15_000);

  test("off by default; turning it on picks a port once, stores it and reopens it after a restart", async () => {
    const first = await network();
    expect(first.status()).toMatchObject({ enabled: false, state: "off", port: 0, addresses: [] });
    const on = await first.update(update("set_enabled", { enabled: true }));
    expect(on.state).toBe("on");
    expect(on.port).toBeGreaterThanOrEqual(20_000);
    expect(on.port).toBeLessThan(32_000);
    expect(on.addresses.map((a) => a.origin)).toEqual([`https://127.0.0.1:${on.port}`]);
    expect(on.fingerprint).toBe((await store.identity()).fingerprint);
    expect(await open(on.port)).toBe(true);
    await first.close();

    const second = await network();
    expect(second.status()).toMatchObject({ enabled: true, state: "on", port: on.port });
    expect(await open(on.port)).toBe(true);
    expect((await second.update(update("set_enabled", { enabled: false }))).state).toBe("off");
    expect(await open(on.port)).toBe(false);
    expect(
      await store.query("SELECT enabled, port FROM network_access WHERE owner_user_id=$1::uuid", [gw.userId]),
    ).toEqual([{ enabled: false, port: on.port }]);
    await second.close();
  }, 20_000);

  test("a busy port is reported in words, keeps the current listener and a new free port recovers", async () => {
    const access = await network();
    const on = await access.update(update("set_enabled", { enabled: true }));
    const busy = await occupy();

    try {
      expect(await failure(access.update(update("set_port", { port: busy.port })))).toContain(
        `Port ${busy.port} is already used by another app`,
      );
      expect(access.status()).toMatchObject({ state: "on", port: on.port });
      expect(await open(on.port)).toBe(true);

      // A stored port taken by another app while Canopy was stopped: an error state, not a crash.
      await access.close();
      await store.query("UPDATE network_access SET port=$2 WHERE owner_user_id=$1::uuid", [gw.userId, busy.port]);
      const restarted = await network();
      expect(restarted.status()).toMatchObject({ enabled: true, state: "error", port: busy.port });
      expect(restarted.status().error).toContain("already used");
      const chosen = await restarted.update(update("choose_port"));
      expect(chosen.state).toBe("on");
      expect(chosen.port).not.toBe(busy.port);
      expect(chosen.error).toBe("");
      expect(await open(chosen.port)).toBe(true);
      await restarted.update(update("set_enabled", { enabled: false }));
      await restarted.close();
    } finally {
      busy.close();
    }
  }, 20_000);

  test("a port fixed by the server environment wins over the stored one and can't be changed in the app", async () => {
    const fixed = await occupy();
    const port = fixed.port;
    await new Promise<void>((resolve) => fixed.close(() => resolve()));
    await store.query("UPDATE network_access SET enabled=true, port=21000 WHERE owner_user_id=$1::uuid", [gw.userId]);
    const access = await network({ port });
    expect(access.status()).toMatchObject({ state: "on", port, portFixed: true });
    expect(await failure(access.update(update("set_port", { port: 21001 })))).toContain("configuration sets the port");
    expect(await failure(access.update(update("choose_port")))).toContain("configuration sets the port");
    // The stored choice stays for a start without the override.
    expect(await store.query("SELECT port FROM network_access WHERE owner_user_id=$1::uuid", [gw.userId])).toEqual([
      { port: 21000 },
    ]);
    await access.update(update("set_enabled", { enabled: false }));
    await access.close();
  }, 20_000);

  test("added hostnames become addresses on the listener's port or their own; changes are announced", async () => {
    const access = await network();
    const on = await access.update(update("set_enabled", { enabled: true }));
    let changes = 0;
    const stop = access.onChange(() => changes++);

    const named = await access.update(
      update("set_hostnames", { hostnames: ["Laptop.example.ts.net", "canopy.example.com:8443", ""] }),
    );

    expect(named.hostnames).toEqual(["laptop.example.ts.net", "canopy.example.com:8443"]);
    expect(named.addresses.filter((a) => a.kind === "hostname").map((a) => a.origin)).toEqual([
      `https://laptop.example.ts.net:${on.port}`,
      "https://canopy.example.com:8443",
    ]);
    expect(changes).toBe(1);
    expect(
      await failure(access.update(update("set_hostnames", { hostnames: ["https://laptop.example.ts.net"] }))),
    ).toContain("isn't a hostname");
    expect(
      await failure(
        access.update(update("set_hostnames", { hostnames: Array.from({ length: 9 }, (_, i) => `h${i}.example`) })),
      ),
    ).toContain("at most 8");
    stop();
    await access.update(update("set_hostnames", { hostnames: [] }));
    await access.update(update("set_enabled", { enabled: false }));
    await access.close();
  }, 20_000);

  test("the web API reads and changes network access", async () => {
    const access = await network();
    gw.core.network = access;

    try {
      expect((await gw.api.updateNetworkAccess({ action: "set_enabled", enabled: true })).state).toBe("on");
      expect((await gw.api.getNetworkAccess({})).enabled).toBe(true);
      expect(await failure(gw.api.updateNetworkAccess({ action: "reboot" }))).toContain("Unknown");
      await gw.api.updateNetworkAccess({ action: "set_enabled", enabled: false });
    } finally {
      delete gw.core.network;
      await access.close();
    }
  }, 20_000);
});

describe.skipIf(!dockerAvailable)("linked computers over network access", () => {
  let a: TestGateway;
  let b: TestGateway;
  let la: LinkedComputers;
  let lb: LinkedComputers;
  const routesOf = async (gw: TestGateway) => (await gw.api.getComputers({})).peers[0]?.routes ?? [];

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });

    for (const [gw, set] of [
      [a, (c: LinkedComputers) => (la = c)],
      [b, (c: LinkedComputers) => (lb = c)],
    ] as const) {
      const computers = linkedComputers({
        store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
        host: "127.0.0.1",
        heartbeatMs: 100,
      });

      gw.core.computers = computers;
      gw.core.network = computers.options.network;
      set(computers);
      await computers.start();
    }
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled([la?.close(), lb?.close()]);
    await a?.close();
    await b?.close();
  }, 15_000);

  test("a code needs network access on; the invitation lists every address and any of them pairs", async () => {
    await a.api.updateNetworkAccess({ action: "set_enabled", enabled: false });
    expect(await failure(a.api.createComputerPairing({}))).toContain("Turn on network access");
    const on = await a.api.updateNetworkAccess({ action: "set_enabled", enabled: true });
    expect((await a.api.getComputers({})).listenerEnabled).toBe(true);
    await a.api.updateNetworkAccess({ action: "set_hostnames", hostnames: ["localhost"] });
    const invitation = await a.api.createComputerPairing({});

    expect(invitation.addresses).toEqual([`https://127.0.0.1:${on.port}`, `https://localhost:${on.port}`]);
    // The first address is dead on B's side: pairing works through the second one.
    await b.api.linkComputer({ address: invitation.addresses[1]!, code: invitation.code });
    await eventually(async () => (await a.api.getComputers({})).peers[0]?.status === "connected");
    expect((await routesOf(b)).find((r) => r.address === `https://localhost:${on.port}`)?.source).toBe("manual");
  }, 25_000);

  test("a new hostname reaches the linked computer as an announced route", async () => {
    const port = (await a.api.getNetworkAccess({})).port;
    await a.api.updateNetworkAccess({ action: "set_hostnames", hostnames: ["localhost", "a.example.ts.net"] });
    await eventually(async () =>
      (await routesOf(b)).some((r) => r.address === `https://a.example.ts.net:${port}` && r.source === "announced"),
    );
  }, 15_000);

  test("a TLS client without a certificate never reaches the link service", async () => {
    const port = (await a.api.getNetworkAccess({})).port;

    const status = await new Promise<number>((resolve, reject) => {
      const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
      socket.once("secureConnect", () =>
        socket.write(
          "POST /canopy.link.v1.ComputerLinkService/Pair HTTP/1.1\r\nhost: x\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        ),
      );
      let text = "";
      socket.on("data", (d) => (text += d.toString()));
      socket.once("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0)));
      socket.once("error", reject);
    });

    expect(status).toBe(403);
  }, 10_000);
});
