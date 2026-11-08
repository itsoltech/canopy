import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { openListener, type Listener } from "../../apps/gateway/src/network/listener.ts";
import {
  ProbeError,
  routedMobileClient,
  type MobileConnection,
  type PinnedTransport,
} from "../../apps/mobile/src/api/routes.ts";
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
      probe: (origin, pin, signal, timeoutMs) => {
        probes.set(origin, (probes.get(origin) ?? 0) + 1);

        return real.probe(origin, pin, signal, timeoutMs);
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

  test("requests arriving while RPC headers are pending reuse the successful probe", async () => {
    const { transport, probes } = counted();

    const client = routedMobileClient({
      connection: { fingerprint, addresses: [alive] },
      transport: {
        ...transport,
        async fetch(url, init, pin) {
          const response = await transport.fetch(url, init, pin);
          await Bun.sleep(150);

          return response;
        },
      },
    });

    const before = requests;
    const first = client.api.getOverview({});
    await Bun.sleep(50);
    await Promise.all([first, ...Array.from({ length: 12 }, () => client.api.getOverview({}))]);
    expect(requests - before).toBe(13);
    expect(probes.get(alive)).toBe(1);
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

  test("tailnet IP bypasses broken MagicDNS even when the saved route is the hostname", async () => {
    const dns = "https://computer.tailnet.ts.net:23456";
    const ip = "https://100.64.0.9:23456";
    const real = nodePinnedTransport();
    const probes: string[] = [];

    const client = routedMobileClient({
      connection: { fingerprint, addresses: [dns, ip], lastAddress: dns },
      transport: {
        ...real,
        probe(route, pin, signal, timeoutMs) {
          probes.push(route);

          return route === dns
            ? Promise.reject(new ProbeError("UnknownHostException"))
            : real.probe(alive, pin, signal, timeoutMs);
        },
        fetch: (_url, init, pin) => real.fetch(`${alive}/canopy.ui.v1.GatewayService/GetOverview`, init, pin),
      },
    });

    await client.api.getOverview({});
    expect(probes).toEqual([ip]);
    expect(client.diagnostics.snapshot().active).toBe(ip);
  });

  test("a pin mismatch and refusal identify their routes without retrying the pin", async () => {
    const wrong = "https://changed.invalid:23456";
    const real = nodePinnedTransport();
    let pinChecks = 0;

    const client = routedMobileClient({
      connection: { fingerprint, addresses: [wrong, refused, alive] },
      transport: {
        ...real,
        probe(route, pin, signal, timeoutMs) {
          if (route === wrong) {
            pinChecks++;

            return real.probe(alive, "f".repeat(64), signal, timeoutMs);
          }

          return real.probe(route, pin, signal, timeoutMs);
        },
      },
    });

    await client.api.getOverview({});
    expect(pinChecks).toBe(1);
    expect(client.diagnostics.snapshot().routes.find((route) => route.address === wrong)?.outcome).toBe("pin");
    expect(client.diagnostics.snapshot().routes.find((route) => route.address === refused)?.outcome).toBe("refused");
  });

  test("an RPC whose response is lost is never replayed on another route", async () => {
    const real = nodePinnedTransport();

    const client = routedMobileClient({
      connection: { fingerprint, addresses: [alive, refused] },
      transport: {
        ...real,
        async fetch(url, init, pin) {
          const response = await real.fetch(url, init, pin);
          await response.arrayBuffer();
          throw new ProbeError("SocketTimeoutException");
        },
      },
    });

    const before = requests;
    await expect(client.api.getOverview({})).rejects.toThrow();
    expect(requests - before).toBe(1);
    expect(client.diagnostics.snapshot().routes.find((route) => route.address === alive)?.phase).toBe("request");
    expect(client.diagnostics.snapshot().routes.find((route) => route.address === alive)?.outcome).toBe("timeout");
  });

  test("a body failure after headers invalidates the route without replay", async () => {
    const real = nodePinnedTransport();

    const client = routedMobileClient({
      connection: { fingerprint, addresses: [alive] },
      transport: {
        ...real,
        async fetch(url, init, pin) {
          const response = await real.fetch(url, init, pin);
          await response.arrayBuffer();

          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new ProbeError("SocketTimeoutException"));
              },
            }),
            { status: response.status, headers: response.headers },
          );
        },
      },
    });

    const before = requests;
    await expect(client.api.getOverview({})).rejects.toThrow();
    expect(requests - before).toBe(1);
    expect(client.diagnostics.snapshot().active).toBeUndefined();
    expect(client.diagnostics.snapshot().routes[0]?.outcome).toBe("timeout");
  });

  test("reset during a blackholed race cancels it and ignores its late results", async () => {
    const { transport, probes } = counted();
    const client = phone(transport);
    const before = requests;
    const abandoned = client.api.getOverview({}).catch(() => undefined);
    await Bun.sleep(50);
    client.reset();
    await client.api.getOverview({});
    await abandoned;
    expect(requests - before).toBe(1);
    expect(probes.get(silent)).toBe(2);
    expect(client.diagnostics.snapshot().active).toBe(alive);
    expect(client.diagnostics.snapshot().pending).toBe(false);
  });

  test("blackholed routes share one bounded recovery window", async () => {
    const { transport } = counted();

    const client = routedMobileClient({
      connection: { fingerprint, addresses: [silent, refused, quiet] },
      transport,
    });

    const started = performance.now();
    await expect(client.api.getOverview({})).rejects.toThrow("Cannot reach this computer securely");
    expect(performance.now() - started).toBeLessThan(12_000);
    expect(client.diagnostics.snapshot().pending).toBe(false);
    expect(client.diagnostics.snapshot().routes.filter((route) => route.outcome === "timeout")).toHaveLength(2);
  }, 15_000);
});
