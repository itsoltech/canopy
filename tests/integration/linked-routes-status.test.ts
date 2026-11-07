import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { dockerAvailable } from "@canopy/db/testing";
import { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually as poll, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { PEER_BACKOFF_MS } from "../../apps/gateway/src/computers/timing.ts";

async function eventually(predicate: () => Promise<boolean>, timeoutMs = 15_000) {
  expect(await poll(predicate, Boolean, timeoutMs)).toBe(true);
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  return port;
}

const HEARTBEAT_MS = 500;

// Nothing listens there: an announced address the other computer cannot reach (a firewall, another network).
const UNREACHABLE = "127.0.0.9";

describe.skipIf(!dockerAvailable)("route status of two linked gateways", () => {
  let a: TestGateway;
  let b: TestGateway;
  let sa: ComputerStore;
  let sb: ComputerStore;
  let la: LinkedComputers;
  let lb: LinkedComputers;
  let portA = 0;
  let portB = 0;
  let hostsB = [UNREACHABLE];
  const peer = async (gw: TestGateway) => (await gw.api.getComputers({})).peers[0]!;

  const makeA = () => linkedComputers({ store: sa, host: "127.0.0.1", port: portA, heartbeatMs: HEARTBEAT_MS });

  // B's listener is on 127.0.0.1, but it announces whatever `hostsB` says.
  const makeB = () =>
    linkedComputers({
      store: sb,
      host: "127.0.0.1",
      port: portB,
      detect: () => hostsB.map((host) => ({ host, kind: "lan" as const, interfaceName: "test" })),
      heartbeatMs: HEARTBEAT_MS,
    });

  async function restart(side: "a" | "b", meanwhile = async () => {}) {
    if (side === "a") {
      await la.close();
      await meanwhile();
      la = makeA();
      a.core.computers = la;
      a.core.network = la.options.network;
      await la.start();
    } else {
      await lb.close();
      await meanwhile();
      lb = makeB();
      b.core.computers = lb;
      b.core.network = lb.options.network;
      await lb.start();
    }
  }

  const online = (timeoutMs = 15_000) =>
    eventually(async () => (await peer(a)).status === "connected" && (await peer(b)).status === "connected", timeoutMs);

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });
    sa = new ComputerStore(a.runtime, a.userId, a.secretsKey);
    sb = new ComputerStore(b.runtime, b.userId, b.secretsKey);
    portA = await freePort();
    portB = await freePort();
    la = makeA();
    lb = makeB();
    a.core.computers = la;
    a.core.network = la.options.network;
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await la.start();
    await lb.start();
    const pairing = await a.api.createComputerPairing({});
    await b.api.linkComputer({ address: la.addresses[0]!, code: pairing.code });
    await online();
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled([la?.close(), lb?.close()]);
    await a?.close();
    await b?.close();
  }, 15_000);

  test("a link the partner dialled is incoming, and the dialling side marks its route in use", async () => {
    const onB = await peer(b);
    expect(onB.connectionDirection).toBe("outgoing");
    expect(onB.routes.find((r) => r.address === la.addresses[0])).toMatchObject({ source: "manual", inUse: true });
    const onA = await peer(a);
    expect(onA.connectionDirection).toBe("incoming");
    expect(onA.routes.map((r) => [r.address, r.inUse])).toEqual([[`https://${UNREACHABLE}:${portB}`, false]]);
  });

  test("failed outbound routes stay recorded while the partner keeps the link up from its side", async () => {
    // B goes away: A dials B's only announced address and fails.
    await lb.close();
    await eventually(async () => (await peer(a)).routes[0]!.lastFailureMs > 0n, PEER_BACKOFF_MS + 15_000);
    await restart("b");
    await online();
    // B announces its addresses again; they are current, and A still could not dial them.
    await eventually(async () => (await peer(a)).routes[0]!.withdrawnAtMs === 0n);
    const onA = await peer(a);
    expect(onA.status).toBe("connected");
    expect(onA.connectionDirection).toBe("incoming");
    const [route] = onA.routes;
    expect(route!.lastFailureMs).toBeGreaterThan(route!.lastSuccessMs);
    expect(route!.inUse).toBe(false);
  }, 70_000);

  test("a reconnect over a route clears its failure and puts it in use", async () => {
    const address = la.addresses[0]!;
    // A stops: B's dials to A fail until A is back on the same port.
    await la.close();
    await eventually(async () => {
      const route = (await peer(b)).routes.find((r) => r.address === address)!;

      return route.lastFailureMs > route.lastSuccessMs;
    }, PEER_BACKOFF_MS + 15_000);
    await restart("a");
    // No discovery/announcement can reach B here. The failed dial has opened the next circuit window.
    await online(PEER_BACKOFF_MS * 2 + 15_000);
    await eventually(async () => {
      const route = (await peer(b)).routes.find((r) => r.address === address)!;

      return route.inUse && route.lastSuccessMs > route.lastFailureMs;
    });
    expect((await peer(b)).connectionDirection).toBe("outgoing");
  }, 120_000);

  test("a re-announce on a new port makes the stale address old, and a working new route removes it", async () => {
    const stale = `https://${UNREACHABLE}:${portB}`;
    // B restarts on another port and now announces a reachable address.
    portB = await freePort();
    hostsB = ["127.0.0.1"];
    const current = `https://127.0.0.1:${portB}`;
    await restart("b");
    await online();
    await eventually(async () => {
      const routes = (await peer(a)).routes;

      return (
        routes.some((r) => r.address === current && r.withdrawnAtMs === 0n) &&
        routes.some((r) => r.address === stale && r.withdrawnAtMs > 0n)
      );
    });
    // Old addresses are tried last.
    expect((await peer(a)).routes.at(-1)!.address).toBe(stale);
    // Only A can dial now: once the current route works, the old address goes away.
    await a.api.updateNetworkAccess({ action: "set_enabled", enabled: false });

    try {
      await restart("a");
      await online();
      await eventually(async () => {
        const onA = await peer(a);

        return (
          onA.connectionDirection === "outgoing" &&
          onA.routes.some((r) => r.address === current && r.inUse) &&
          !onA.routes.some((r) => r.address === stale)
        );
      });
    } finally {
      await a.api.updateNetworkAccess({ action: "set_enabled", enabled: true });
    }
  }, 45_000);

  test("an address announced again is current again", async () => {
    const current = `https://127.0.0.1:${portB}`;
    // B is down and A marks its address old; B's next hello lists it again.
    await lb.close();
    await sa.query("UPDATE computer_routes SET withdrawn_at=now() WHERE owner_user_id=$1::uuid AND address=$2", [
      a.userId,
      current,
    ]);
    expect((await peer(a)).routes.find((r) => r.address === current)!.withdrawnAtMs).toBeGreaterThan(0n);
    await restart("b");
    await eventually(async () => (await peer(a)).routes.find((r) => r.address === current)?.withdrawnAtMs === 0n);
  }, 30_000);
});
