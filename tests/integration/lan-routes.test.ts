import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import * as dns from "dns-packet";
import { dockerAvailable } from "@canopy/db/testing";
import { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { ROUTE_ORDER } from "../../apps/gateway/src/computers/routes.ts";
import { discoveryKey, lanNames, lanWindow } from "../../apps/gateway/src/computers/lan.ts";
import { eventually as poll, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { MemoryLan } from "./support/lan.ts";

async function eventually(predicate: () => Promise<boolean>, timeoutMs = 8000) {
  expect(await poll(predicate, Boolean, timeoutMs)).toBe(true);
}

/** Counts TCP connections: a discovered address is used only for the pinned handshake. A dedicated loopback
 * address keeps out unrelated local processes retrying an old 127.0.0.1 port that the OS hands out again. */
async function counter(host: string) {
  let count = 0;

  const server: Server = createServer((socket) => {
    count++;
    socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(0, host, resolve));

  return {
    port: (server.address() as AddressInfo).port,
    count: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  return port;
}

const SUBNET = { address: "127.0.0.1", netmask: "255.255.255.0" };

// Route discovery has its own fast clock. Keep the unrelated liveness detector long enough for
// pinned handshakes and database work when the integration suites run together.
const HEARTBEAT_MS = 1000;

describe.skipIf(!dockerAvailable)("routes and local network discovery between two linked gateways", () => {
  let a: TestGateway;
  let b: TestGateway;
  let sa: ComputerStore;
  let sb: ComputerStore;
  let la: LinkedComputers;
  let lb: LinkedComputers;
  const lan = new MemoryLan();
  const ifaceB = [SUBNET];
  let portB = 0;
  const routesOf = async (gw: TestGateway) => (await gw.api.getComputers({})).peers[0]?.routes ?? [];
  const status = async (gw: TestGateway) => (await gw.api.getComputers({})).peers[0]?.status;

  const online = () =>
    eventually(async () => (await status(a)) === "connected" && (await status(b)) === "connected", 15_000);

  async function restartA(meanwhile = async () => {}) {
    const port = la.options.port!;
    await la.close();
    await meanwhile();
    la = new LinkedComputers({
      store: sa,
      host: "127.0.0.1",
      port,
      heartbeatMs: HEARTBEAT_MS,
      discovery: discovery("a", [SUBNET]),
    });
    a.core.computers = la;
    await la.start();
  }

  const discovery = (name: string, interfaces: typeof ifaceB) => ({
    transport: lan.transport(name, interfaces),
    queryIntervalMs: 150,
    testIntervalMs: 300,
  });

  beforeAll(async () => {
    a = await startTestGateway();
    b = await startTestGateway();
    sa = new ComputerStore(a.runtime, a.userId, a.secretsKey);
    sb = new ComputerStore(b.runtime, b.userId, b.secretsKey);
    // A fixed port: A's listener is switched off and on to make A the dialling side.
    la = new LinkedComputers({
      store: sa,
      host: "127.0.0.1",
      port: await freePort(),
      heartbeatMs: HEARTBEAT_MS,
      discovery: discovery("a", [SUBNET]),
    });
    // B listens on every interface without configured addresses: it advertises its LAN addresses.
    lb = new LinkedComputers({
      store: sb,
      host: "0.0.0.0",
      heartbeatMs: HEARTBEAT_MS,
      discovery: discovery("b", ifaceB),
    });
    a.core.computers = la;
    b.core.computers = lb;
    await la.start();
    await lb.start();
    portB = Number(new URL(lb.hello().addresses[0]!).port);
    const pairing = await a.api.createComputerPairing({});
    await b.api.linkComputer({ address: la.addresses[0]!, code: pairing.code });
    await online();
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled([la?.close(), lb?.close()]);
    await a?.close();
    await b?.close();
  }, 15_000);

  test("pairing stores the entered address as a manual route and the partner's addresses as announced", async () => {
    const onB = await routesOf(b);
    expect(onB[0]).toMatchObject({ address: la.addresses[0], source: "manual" });
    expect(onB[0]!.lastSuccessMs).toBeGreaterThan(0n);
    expect((await routesOf(a)).find((r) => r.address === `https://127.0.0.1:${portB}`)?.source).toBe("announced");
    expect((await b.api.getComputers({})).lanDiscoveryState).toBe("active");
  });

  test("a linked computer in the same subnet is discovered and its route saved after a pinned handshake", async () => {
    // A no longer knows any address of B: discovery alone has to find it.
    await sa.query("DELETE FROM computer_routes WHERE owner_user_id=$1::uuid", [a.userId]);
    await eventually(async () =>
      (await routesOf(a)).some(
        (r) => r.address === `https://127.0.0.1:${portB}` && r.source === "lan" && r.lastSuccessMs > 0n,
      ),
    );
    const route = (await routesOf(a)).find((r) => r.source === "lan")!;
    expect(route.latencyMs).toBeGreaterThanOrEqual(0);
    // And A reaches B through it when it has to dial: B can no longer reach A.
    await a.api.manageComputer({ action: "listener", enabled: false });

    try {
      // Wait for the old streams and their presence writes to finish before testing a fresh dial.
      await restartA();
      await online();
    } finally {
      await a.api.manageComputer({ action: "listener", enabled: true });
    }
  }, 30_000);

  test("announcements carry only rotating opaque names, the link port and a LAN address", async () => {
    const own = (await sa.identity()).node_id;
    const other = lb.hello().nodeId;
    const names = new Set<string>();

    for (const { packet } of [...lan.from("a"), ...lan.from("b")]) {
      const text = packet.toString("latin1").toLowerCase();

      for (const secret of [
        own.slice(0, 12),
        other.slice(0, 12),
        "canopy",
        la.hello().name.toLowerCase(),
        lb.hello().name.toLowerCase(),
      ])
        expect(text).not.toContain(secret);
      const message = dns.decode(packet);

      for (const q of message.questions ?? []) names.add(q.name);

      for (const r of [...(message.answers ?? []), ...(message.additionals ?? [])]) {
        names.add(r.name);

        if (r.type === "A") expect(r.data).toBe("127.0.0.1");

        if (r.type === "SRV") expect([portB, Number(new URL(la.addresses[0]!).port)]).toContain(r.data.port);

        if (r.type === "TXT") expect([r.data].flat().map((part) => Buffer.from(part).length)).toEqual([0]);
      }
    }

    for (const name of names) expect(name).toMatch(/^(?:[a-z2-7]{26}\.)?(?:_[a-z][a-z2-7]{14}\._tcp\.local|local)$/);
    // Both directions and every window have different names.
    const key = discoveryKey((await sa.identity()).privateKey, own, (await sa.peers())[0]!.certificate, other);
    expect(
      key.equals(discoveryKey((await sb.identity()).privateKey, other, (await sb.peers())[0]!.certificate, own)),
    ).toBe(true);
    const w = lanWindow(Date.now());
    const series = [lanNames(key, own, w), lanNames(key, own, w + 1), lanNames(key, other, w)];
    expect(new Set(series.map((n) => n.service)).size).toBe(3);
    expect(new Set(series.map((n) => n.instance)).size).toBe(3);
  });

  test("names of the adjacent window are accepted, older ones and strangers' announcements are ignored, tests are rate-limited", async () => {
    const target = await counter("127.0.0.77");
    const outside = await counter("127.0.1.1");
    const nodeA = la.hello().nodeId;
    const nodeB = lb.hello().nodeId;

    // Announcements made with B's real key (a clock ahead, or a replay), pointing at an endpoint that is not B.
    const key = discoveryKey(
      lb.identity.privateKey,
      nodeB,
      (await sb.peers()).find((p) => p.node_id === nodeA)!.certificate,
      nodeA,
    );

    const announcement = (window: number, port: number, address = "127.0.0.77") => {
      const n = lanNames(key, nodeB, window);

      return dns.encode({
        type: "response",
        flags: dns.AUTHORITATIVE_ANSWER,
        answers: [{ type: "PTR", name: n.service, ttl: 120, data: n.instance }],
        additionals: [
          { type: "SRV", name: n.instance, ttl: 120, data: { port, target: n.host } },
          { type: "A", name: n.host, ttl: 120, data: address },
        ],
      });
    };

    const fake = "a".repeat(26);

    const stranger = dns.encode({
      type: "response",
      answers: [{ type: "PTR", name: "_abcdefghijklmno._tcp.local", data: `${fake}._abcdefghijklmno._tcp.local` }],
      additionals: [
        {
          type: "SRV",
          name: `${fake}._abcdefghijklmno._tcp.local`,
          data: { port: target.port, target: `${fake}.local` },
        },
        { type: "A", name: `${fake}.local`, data: "127.0.0.77" },
      ],
    });

    const w = lanWindow(Date.now());

    try {
      for (let i = 0; i < 3; i++) {
        lan.deliver(stranger, "127.0.0.9");
        lan.deliver(announcement(w + 2, target.port), "127.0.0.9");
        lan.deliver(announcement(w - 2, target.port), "127.0.0.9");
        lan.deliver(announcement(w, outside.port, "127.0.1.1"), "127.0.1.1");
      }

      await Bun.sleep(600);
      expect(target.count()).toBe(0);
      expect(outside.count()).toBe(0);

      for (let i = 0; i < 5; i++) lan.deliver(announcement(w + 1, target.port), "127.0.0.9");
      await eventually(async () => target.count() > 0);
      await Bun.sleep(150);
      // One handshake attempt per address and interval; an endpoint without B's pinned key is never saved.
      expect(target.count()).toBe(1);
      expect((await routesOf(a)).some((r) => r.address.endsWith(`:${target.port}`))).toBe(false);
    } finally {
      await Promise.all([target.close(), outside.close()]);
    }
  }, 20_000);

  test("a computer announces its new addresses over the link", async () => {
    // Another subnet than A's: only the link, not discovery, can tell A about it.
    ifaceB.push({ address: "127.0.5.2", netmask: "255.255.255.0" });
    await eventually(async () =>
      (await routesOf(a)).some((r) => r.address === `https://127.0.5.2:${portB}` && r.source === "announced"),
    );
    ifaceB.pop();
  }, 15_000);

  test("routes are tried in order of last success and the next one takes over when the best route dies", async () => {
    const dead = await counter("127.0.0.78");
    const deadAddress = `https://127.0.0.78:${dead.port}`;
    const nodeB = lb.hello().nodeId;
    // Only A can dial now (a new runtime without its listener and earlier connections), and its best route is dead.
    // The routes change while A is stopped, so no dial of the old runtime reorders them.
    await a.api.manageComputer({ action: "listener", enabled: false });
    await restartA(async () => {
      await sa.query(
        "UPDATE computer_routes SET last_success=now()-interval '1 hour',last_failure=NULL WHERE owner_user_id=$1::uuid",
        [a.userId],
      );
      await sa.query(
        "INSERT INTO computer_routes (owner_user_id,node_id,address,source,last_success) VALUES ($1::uuid,$2,$3,'manual',now())",
        [a.userId, nodeB, deadAddress],
      );
      expect(
        (
          await sa.query<{ address: string }>(
            `SELECT address FROM computer_routes WHERE owner_user_id=$1::uuid ORDER BY ${ROUTE_ORDER}`,
            [a.userId],
          )
        )[0]!.address,
      ).toBe(deadAddress);
    });

    try {
      const failedRoute = async () => (await routesOf(a)).find((r) => r.address === deadAddress)!;
      await eventually(
        async () => dead.count() > 0 && (await failedRoute()).lastFailureMs > (await failedRoute()).lastSuccessMs,
        10_000,
      );
      // The handshake publishes presence before the dialler records its successful route.
      await eventually(async () => {
        const routes = await routesOf(a);
        const failed = routes.find((r) => r.address === deadAddress)!;

        return (
          routes[0]!.address !== deadAddress &&
          routes[0]!.lastSuccessMs > failed.lastSuccessMs &&
          (await status(a)) === "connected"
        );
      }, 10_000);
      await online();
      const routes = await routesOf(a);
      const failed = routes.find((r) => r.address === deadAddress)!;
      expect(routes[0]!.address).not.toBe(deadAddress);
      expect(routes[0]!.lastSuccessMs).toBeGreaterThan(failed.lastSuccessMs);
      // A failed route goes behind the working ones without being forgotten.
      expect(routes.at(-1)!.address).toBe(deadAddress);
    } finally {
      await a.api.manageComputer({ action: "listener", enabled: true });
      await dead.close();
    }

    await a.api.manageComputer({ action: "remove_route", nodeId: nodeB, address: deadAddress });
  }, 30_000);

  test("routes can be added and removed by hand", async () => {
    const nodeB = lb.hello().nodeId;
    expect(
      await failure(a.api.manageComputer({ action: "add_route", nodeId: nodeB, address: "http://10.0.0.5:4000" })),
    ).toContain("HTTPS");
    await a.api.manageComputer({ action: "add_route", nodeId: nodeB, address: "https://laptop.example:4100/" });
    expect((await routesOf(a)).find((r) => r.address === "https://laptop.example:4100")?.source).toBe("manual");
    await a.api.manageComputer({ action: "remove_route", nodeId: nodeB, address: "https://laptop.example:4100" });
    expect((await routesOf(a)).some((r) => r.address === "https://laptop.example:4100")).toBe(false);
    expect(
      await failure(
        a.api.manageComputer({ action: "remove_route", nodeId: nodeB, address: "https://laptop.example:4100" }),
      ),
    ).toContain("not found");
  });

  test("with discovery off a computer announces nothing, answers nothing and forgets LAN routes", async () => {
    const nodeA = la.hello().nodeId;
    await sb.query(
      "INSERT INTO computer_routes (owner_user_id,node_id,address,source,last_success) VALUES ($1::uuid,$2,'https://127.0.0.3:1','lan',now())",
      [b.userId, nodeA],
    );
    const snapshot = await b.api.manageComputer({ action: "lan_discovery", enabled: false });
    expect(snapshot.lanDiscoveryEnabled).toBe(false);
    expect(snapshot.lanDiscoveryState).toBe("off");
    expect(snapshot.peers[0]!.routes.some((r) => r.source === "lan")).toBe(false);
    const sent = lan.from("b").length;
    await sa.query("DELETE FROM computer_routes WHERE owner_user_id=$1::uuid AND source='lan'", [a.userId]);
    await Bun.sleep(1200);
    expect(lan.from("b").length).toBe(sent);
    expect((await routesOf(a)).some((r) => r.source === "lan")).toBe(false);
    // The setting is durable and turning it back on resumes discovery.
    expect((await sb.identity()).lan_discovery).toBe(false);
    expect((await b.api.manageComputer({ action: "lan_discovery", enabled: true })).lanDiscoveryState).toBe("active");
    await eventually(async () => lan.from("b").length > sent);
  }, 20_000);

  test("unlink removes every route on both computers", async () => {
    await a.api.manageComputer({ action: "unlink", nodeId: lb.hello().nodeId });
    await eventually(async () => !(await sb.peers()).length);
    await Bun.sleep(500);
    expect(await sa.query("SELECT 1 FROM computer_routes WHERE owner_user_id=$1::uuid", [a.userId])).toHaveLength(0);
    expect(await sb.query("SELECT 1 FROM computer_routes WHERE owner_user_id=$1::uuid", [b.userId])).toHaveLength(0);
  }, 15_000);
});
