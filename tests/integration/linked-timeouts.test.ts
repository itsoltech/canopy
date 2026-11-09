import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { eventually } from "./support/gateway.ts";
import { linkedTimeouts, networkPath } from "./support/linked-timeouts.ts";
import { computersAdvertise } from "../../apps/gateway/src/computers/runtime-lan.ts";
import { ui } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { createClient } from "@connectrpc/connect";
import { connectNodeAdapter, createGrpcTransport } from "@connectrpc/connect-node";
import { serviceTokenAuth, uiRoutes } from "@canopy/gateway/api";
import { createServer, type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { isolatedGatewayTransport } from "../../apps/web/src/lib/server/gateway-transport.ts";
import { SERVICE_TOKEN } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("linked computer read deadlines and recovery", () => {
  let f: Awaited<ReturnType<typeof linkedTimeouts>>;

  beforeAll(async () => {
    f = await linkedTimeouts();
  }, 90_000);
  afterAll(async () => {
    await f?.close();
  }, 30_000);

  async function pages() {
    const started = performance.now();

    const [updates, connectors, bots] = await Promise.all([
      f.a.api.getUpdates({}, { timeoutMs: 3000 }),
      f.a.api.listConnectors({}, { timeoutMs: 3000 }),
      f.a.api.listBots({}, { timeoutMs: 3000 }),
    ]);

    expect(performance.now() - started).toBeLessThan(500);
    expect(updates.cliWorkers.map((w) => w.id)).toContain(f.a.workerId);
    expect(connectors.accounts.map((a) => a.id)).toContain(f.account.id);
    expect(bots.bots.map((b) => b.id)).toContain(f.bot.id);

    return { peer: updates.computers.find((c) => c.nodeId === f.node)!, bots };
  }

  async function recovered(timeoutMs = 15_000) {
    expect(
      await eventually(
        async () => {
          const state = await pages();

          return (
            state.peer.readState === "fresh" &&
            !!state.peer.updates &&
            state.bots.unavailableComputers.length === 0 &&
            state.bots.refreshingComputers.length === 0
          );
        },
        Boolean,
        timeoutMs,
      ),
    ).toBe(true);
  }

  test("a peer still sending heartbeats cannot hold local updates or the Connectors page hostage", async () => {
    f.stall();

    try {
      const state = await pages();
      expect(state.peer.readState).toBe("loading");
      expect(state.peer.reason).toContain("Waiting for Studio B");
      expect(state.peer.updates).toBeUndefined();
      expect(state.bots.unavailableComputers).toEqual([]);
      expect(state.bots.refreshingComputers).toMatchObject([{ nodeId: f.node }]);
      expect(f.la.reachable()).toContain(f.node);
      const started = performance.now();

      const [overview, threads, thread] = await Promise.all([
        f.a.api.getOverview({}),
        f.a.api.listThreads({}),
        f.a.api.getThread({ threadId: f.localThread.id }),
        f.a.api.listModels({}),
        f.a.api.listSchedules({}),
        f.a.api.listWorktrees({}),
        f.a.api.getSettings({}),
        f.a.api.listProviderInstances({}),
        f.a.api.listProxies({}),
        f.a.api.getAgentEnvironment({}),
        f.a.api.listWorkerRecords({}),
        f.a.api.getMobileDevices({}),
        f.a.api.searchThreads({ query: "Local" }),
      ]);

      expect(performance.now() - started).toBeLessThan(500);
      expect(overview.workers.map((w) => w.id)).toContain(f.a.workerId);
      expect(threads.threads.map((t) => t.id)).toContain(f.localThread.id);
      expect(thread.thread?.id).toBe(f.localThread.id);
      const toolsStarted = performance.now();

      for (const tool of ["list_agents", "list_threads"]) {
        const result = await f.a.worker.callTool({
          threadId: f.localThread.id,
          tool,
          args: tool === "list_threads" ? { scope: "all" } : {},
        });

        expect(result.isError).toBe(false);
        expect(result.resultJson).toContain(tool === "list_threads" ? '"threads":' : "linked_computers");
      }

      expect(performance.now() - toolsStarted).toBeLessThan(500);
      const stream = new AbortController();

      try {
        for await (const update of f.a.api.watchThread(
          { threadId: f.localThread.id },
          { signal: stream.signal, timeoutMs: 1000 },
        )) {
          expect(update.change.case).toBe("snapshot");
          break;
        }
      } finally {
        stream.abort();
      }

      await Bun.sleep(3200);
      expect((await pages()).peer.readState).toBe("loading");
      expect(f.la.reads.blocked(f.node)).toBe(false);
    } finally {
      f.resume();
    }

    await recovered();
  }, 30_000);

  test("half-open paths expire and reconnect with the existing mTLS pins", async () => {
    const pin = (await f.la.store.peer(f.node))!.fingerprint;
    f.pa.freeze(true);
    f.pb.freeze(true);

    try {
      await pages();
      expect(await eventually(async () => !f.la.reachable().includes(f.node), Boolean, 15_000)).toBe(true);
      const state = await pages();
      expect(state.peer.readState).toBe("unavailable");
      expect(state.peer.updates).toBeDefined();
      expect(state.bots.unavailableComputers.map((c) => c.nodeId)).toContain(f.node);
      expect(f.la.reads.blocked(f.node)).toBe(true);
    } finally {
      f.pa.thaw();
      f.pb.thaw();
    }

    await recovered(45_000);
    expect((await f.la.store.peer(f.node))!.fingerprint).toBe(pin);
  }, 60_000);

  test("slow live reads time out without declaring the computer dead or repeating on every poll", async () => {
    const before = f.requests.get("GetComputerUpdates") ?? 0;
    f.stall();

    try {
      // Other background reads can delay admission. Wait for this RPC before checking its timeout.
      expect(
        await eventually(
          async () => {
            await pages();

            return (f.requests.get("GetComputerUpdates") ?? 0) > before;
          },
          Boolean,
          20_000,
        ),
      ).toBe(true);
      expect(await eventually(async () => (await pages()).peer.readState === "stale", Boolean, 20_000)).toBe(true);
      const calls = f.requests.get("GetComputerUpdates") ?? 0;
      await Bun.sleep(10_500);

      for (let i = 0; i < 12; i++) {
        const state = await pages();
        expect(state.peer.readState).toBe("stale");
        expect(state.bots.unavailableComputers).toEqual([]);
      }

      expect(f.requests.get("GetComputerUpdates")).toBe(calls);
      expect(f.la.reachable()).toContain(f.node);
      expect(f.la.reads.blocked(f.node)).toBe(false);
    } finally {
      f.resume();
    }

    // A genuine reconnect clears both connection backoff and stale-read cooldown immediately.
    await f.la.announce("sleeping");
    await f.la.announce("connected");
    await recovered();
  }, 75_000);

  test("a stalled peer action and an open subscription cannot occupy local BFF request slots", async () => {
    const sessions = new Set<ServerHttp2Session>();

    const server = createServer(
      { settings: { maxConcurrentStreams: 1 } },
      connectNodeAdapter({ routes: uiRoutes(f.a.core), interceptors: [serviceTokenAuth(SERVICE_TOKEN)] }),
    );

    server.on("session", (session) => {
      sessions.add(session);
      session.once("close", () => sessions.delete(session));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: The server listens on an ephemeral loopback TCP port.
    const port = (server.address() as AddressInfo).port;

    const client = createClient(
      ui.GatewayService,
      isolatedGatewayTransport(() =>
        createGrpcTransport({
          baseUrl: `http://127.0.0.1:${port}`,
          interceptors: [
            (next) => (request) => {
              request.header.set("authorization", `Bearer ${SERVICE_TOKEN}`);

              return next(request);
            },
          ],
        }),
      ),
    );

    const controller = new AbortController();
    f.stall();
    const before = f.requests.get("GetThread") ?? 0;

    const held = client
      .getThread({ threadId: qualifyId(f.remoteThread.id, f.node) }, { signal: controller.signal })
      .catch(() => undefined);

    const beforeWatch = f.requests.get("WatchThread") ?? 0;

    const remoteStream = client
      .watchThread({ threadId: qualifyId(f.remoteThread.id, f.node) }, { signal: controller.signal })
      [Symbol.asyncIterator]();

    const remoteNext = remoteStream.next().catch(() => undefined);

    const stream = client
      .watchThread({ threadId: f.localThread.id }, { signal: controller.signal })
      [Symbol.asyncIterator]();

    try {
      expect(await eventually(async () => (f.requests.get("GetThread") ?? 0) > before, Boolean)).toBe(true);
      expect(await eventually(async () => (f.requests.get("WatchThread") ?? 0) > beforeWatch, Boolean)).toBe(true);
      const opening = performance.now();
      expect((await stream.next()).value?.change.case).toBe("snapshot");
      expect(performance.now() - opening).toBeLessThan(500);
      const started = performance.now();
      await client.getSettings({});
      expect(performance.now() - started).toBeLessThan(500);
      expect(sessions.size).toBe(4);
    } finally {
      controller.abort();
      f.resume();
      await held;
      await remoteNext;
      await remoteStream.return?.().catch(() => undefined);
      await stream.return?.().catch(() => undefined);

      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  test("wake retires silent old paths immediately, before heartbeat expiry", async () => {
    await f.la.announce("sleeping");
    f.pa.freeze();
    f.pb.freeze();
    const started = performance.now();
    await f.la.announce("connected");
    expect(await eventually(async () => f.la.reachable().includes(f.node), Boolean, 4000)).toBe(true);
    expect(performance.now() - started).toBeLessThan(4000);
    await recovered();
  }, 30_000);

  test("a network-address change retires silent links without changing trust", async () => {
    const fresh = await networkPath(f.la.options.network.port!);
    const origins = f.la.options.network.origins;
    const pin = (await f.la.store.peer(f.node))!.fingerprint;
    f.pa.freeze();
    f.pb.freeze();

    try {
      const started = performance.now();
      f.la.options.network.origins = () => [fresh.address];
      computersAdvertise(f.la);
      await recovered();
      expect(performance.now() - started).toBeLessThan(4000);
      expect((await f.la.store.peer(f.node))!.fingerprint).toBe(pin);
    } finally {
      f.la.options.network.origins = origins;
      computersAdvertise(f.la);
      await fresh.close();
    }
  }, 30_000);

  test("an incoming-only partner learns a changed route before the old link retires", async () => {
    await f.b.api.updateNetworkAccess({ action: "set_enabled", enabled: false });
    expect(
      await eventually(async () => (await f.la.computer(f.node))?.connectionDirection === "incoming", Boolean, 15_000),
    ).toBe(true);
    await recovered();
    const fresh = await networkPath(f.la.options.network.port!);
    f.pa.stopAccepting();

    try {
      f.la.options.network.origins = () => [fresh.address];
      computersAdvertise(f.la);
      expect(
        await eventually(
          async () =>
            (await f.lb.snapshot()).peers
              .find((p) => p.nodeId === f.la.hello().nodeId)
              ?.routes.some((r) => r.address === fresh.address && r.inUse),
          Boolean,
          15_000,
        ),
      ).toBe(true);
      await recovered();
    } finally {
      await fresh.close();
    }
  }, 30_000);
});
