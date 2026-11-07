import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { openListener, type Listener } from "../../apps/gateway/src/network/listener.ts";
import { routedMobileClient, type MobileConnection, type PinnedTransport } from "../../apps/mobile/src/api/routes.ts";
import { nodePinnedTransport } from "./support/phone.ts";

/** A phone returning with dead routes in its pairing: a blackholed address (connects, never answers TLS, like a
 * LAN address seen from another network) and a refused one, before the computer's working address. */
describe("phone route selection", () => {
  let computer: Listener;
  const blackholes: Server[] = [];
  const held = new Set<Socket>();
  let fingerprint = "";
  let alive = "";
  let silent = "";
  let quiet = "";
  let refused = "";
  let requests = 0;

  beforeAll(async () => {
    const identity = await generateIdentity();
    fingerprint = identity.fingerprint;

    const adapter = connectNodeAdapter({
      routes: (router) =>
        router.service(ui.GatewayService, {
          getOverview: () => {
            requests++;

            return create(ui.GetOverviewResponseSchema, {});
          },
        }),
    });

    computer = await openListener({ host: "127.0.0.1", port: 0, identity, route: () => adapter });
    alive = `https://127.0.0.1:${computer.port}`;
    [silent, quiet] = await Promise.all([hole(), hole()]);
    const spare = createServer();
    await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
    // SAFETY: the spare server listened on a TCP host/port; closed, its port refuses connections.
    refused = `https://127.0.0.1:${(spare.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => spare.close(() => resolve()));
  });

  afterAll(async () => {
    for (const socket of held) socket.destroy();
    await Promise.all(blackholes.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await computer?.close();
  });

  /** Accepts the connection and never answers the TLS handshake. */
  async function hole() {
    const server = createServer((socket) => held.add(socket));
    blackholes.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    // SAFETY: the blackhole listens on a TCP host/port.
    return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** The real TLS transport, counting probes per address and resets. */
  function counted() {
    const real = nodePinnedTransport();
    const probes = new Map<string, number>();
    let resets = 0;

    const transport: PinnedTransport = {
      probe: (origin, pin, signal) => {
        probes.set(origin, (probes.get(origin) ?? 0) + 1);

        return real.probe(origin, pin, signal);
      },
      fetch: real.fetch,
      reset: () => resets++,
    };

    return { transport, probes, resets: () => resets };
  }

  function phone(transport: PinnedTransport, saved: (connection: MobileConnection) => void = () => {}) {
    // The pairing saved a dead route as the last one that worked.
    return routedMobileClient({
      connection: { fingerprint, addresses: [silent, refused, quiet, alive], lastAddress: silent },
      transport,
      changed: saved,
    });
  }

  test("dead routes cost a moment, not their timeouts, and the working one is saved", async () => {
    const { transport } = counted();
    let saved: MobileConnection | undefined;
    const client = phone(transport, (connection) => (saved = connection));
    const started = performance.now();
    await client.api.getOverview({});

    // Probing one route after another waited for every dead route's 2 s timeout first.
    expect(performance.now() - started).toBeLessThan(1500);
    expect(saved?.lastAddress).toBe(alive);
  });

  test("requests at the same time share one race, then reuse the route without a handshake", async () => {
    const { transport, probes } = counted();
    const client = phone(transport);
    const before = requests;
    await Promise.all(Array.from({ length: 12 }, () => client.api.getOverview({})));
    await client.api.getOverview({});

    expect(requests - before).toBe(13);
    expect(probes.get(alive)).toBe(1);
    expect(Math.max(...probes.values())).toBe(1);
  });

  test("a request canceled while routes are probed doesn't stop the race for the next one", async () => {
    const { transport, probes } = counted();
    let saved: MobileConnection | undefined;
    const client = phone(transport, (connection) => (saved = connection));
    const canceled = new AbortController();
    const first = client.api.getOverview({}, { signal: canceled.signal });
    setTimeout(() => canceled.abort(), 50);
    await expect(first).rejects.toThrow();
    await client.api.getOverview({});

    expect(probes.get(silent)).toBe(1);
    expect(saved?.lastAddress).toBe(alive);
  });

  test("reset drops the chosen route and the pooled connections", async () => {
    const { transport, probes, resets } = counted();
    const client = phone(transport);
    await client.api.getOverview({});
    client.reset();
    await client.api.getOverview({});

    expect(resets()).toBe(1);
    expect(probes.get(alive)).toBe(2);
    expect(client.connection().lastAddress).toBe(alive);
  });

  test("with no working route the phone learns it after one timeout, not one per route", async () => {
    const { transport } = counted();

    const client = routedMobileClient({
      connection: { fingerprint, addresses: [silent, refused, quiet] },
      transport,
    });

    const started = performance.now();
    await expect(client.api.getOverview({})).rejects.toThrow("Cannot reach this computer securely");
    expect(performance.now() - started).toBeLessThan(3500);
  });
});
