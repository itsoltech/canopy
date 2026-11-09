import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { Provider, ui } from "@canopy/contracts";
import { linkedMessage } from "../../apps/gateway/src/computers/remote.ts";
import { qualifyId, REMOTE_THREADS, THREAD_MIRROR } from "@canopy/domain/computers";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("linked thread application liveness", () => {
  let a: TestGateway;
  let b: TestGateway;
  let local: LinkedComputers;
  let home: LinkedComputers;
  let store: ComputerStore;
  let thread: string;
  let node: string;
  let fault: "none" | "stall" | "fanout" | "gap" | "base" | "all" = "none";
  let mirrorStalled = false;
  let mirrorError = false;
  let dropped = false;
  let subscriptions = 0;
  let mirrorSubscriptions = 0;
  const timing = { heartbeatMs: 100, timeoutMs: 1000, legacyProbeMs: 1500 };

  async function title(value: string) {
    await b.api.updateThread({ threadId: thread, title: value });
  }

  async function follow(pageSize = 0, cursor = "", base?: ui.ThreadSnapshot) {
    const abort = new AbortController();
    const updates: ui.ThreadUpdate[] = [];
    let state = base;
    let failure: unknown;

    const done = (async () => {
      try {
        for await (const update of a.api.watchThread(
          { threadId: qualifyId(thread, node), pageSize, incremental: !!pageSize, cursor },
          { signal: abort.signal },
        )) {
          updates.push(update);
          state = applyThreadUpdate(state, update);
        }
      } catch (cause) {
        if (!abort.signal.aborted) failure = cause;
      }
    })();

    return {
      updates,
      get state() {
        return state;
      },
      get failure() {
        return failure;
      },
      async until(value: string) {
        expect(
          await eventually(
            async () => state?.thread?.title,
            (name) => name === value,
            5000,
          ),
        ).toBe(value);
        expect(failure).toBeUndefined();
      },
      async close() {
        abort.abort();
        await done;
      },
    };
  }

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });
    store = new ComputerStore(b.runtime, b.userId, b.secretsKey);
    const project = (await b.api.createProject({ name: "Remote work" })).project!.id;

    const workspace = (
      await b.api.createWorkspace({ projectId: project, workerId: b.workerId, rootPath: "/repo/live" })
    ).workspace!.id;

    thread = (
      await b.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        title: "Initial",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;

    const options = (gateway: TestGateway) => ({
      store: new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey),
      host: "127.0.0.1",
      heartbeatMs: 100,
      watchTiming: timing,
      serve: remoteServe(uiHandlers(gateway.core)),
    });

    local = linkedComputers(options(a));
    home = linkedComputers(options(b));
    const remote = local.remote.bind(local);
    local.remote = async function* (...args) {
      const watching = args[1].name === "WatchThread";

      if (watching) subscriptions++;
      let seeded = false;

      for await (const message of remote(...args)) {
        if (args[1].name === "WatchThreadMirror" && mirrorError) {
          mirrorError = false;
          throw new ConnectError("Injected mirror stream failure", Code.Unavailable);
        }

        if (watching) {
          if (fault === "all" || (fault === "stall" && seeded)) {
            dropped = true;
            continue;
          }

          const update = linkedMessage(ui.ThreadUpdateSchema, message);

          if (fault === "fanout" && seeded && !update.watchCursor) {
            dropped = true;
            continue;
          }

          if (fault === "gap" && update.change.case === "event") {
            fault = "none";
            dropped = true;
            continue;
          }

          if (fault === "base" && update.change.case === "delta") {
            update.change.value.baseCursor = "invalid";
            fault = "none";
          }

          if (update.change.case === "snapshot" || update.change.case === "delta") seeded = true;
          yield update;
        } else yield message;
      }
    };

    const publish = home.mirror.publish.bind(home.mirror);
    home.mirror.publish = async function* (...args) {
      mirrorSubscriptions++;

      for await (const frame of publish(...args)) {
        if (mirrorStalled) {
          dropped = true;
          continue;
        }

        yield frame;
      }
    };

    a.core.computers = local;
    a.core.network = local.options.network;
    b.core.computers = home;
    b.core.network = home.options.network;
    await local.start();
    await home.start();
    node = home.hello().nodeId;
    const pairing = await local.createPairing();
    await home.pair(local.addresses[0]!, pairing.code);
    expect(
      await eventually(
        async () => (await local.mirror.snapshot(node, thread))?.thread?.title,
        (value) => value === "Initial",
        15_000,
      ),
    ).toBe("Initial");
  }, 90_000);

  afterAll(async () => {
    fault = "none";
    mirrorStalled = false;
    await Promise.allSettled([local?.close(), home?.close()]);
    await a?.close();
    await b?.close();
  }, 30_000);

  test("a stalled but open watch resubscribes while the link stays connected", async () => {
    const view = await follow();

    try {
      await view.until("Initial");
      const before = subscriptions;
      fault = "stall";
      dropped = false;
      await title("Recovered stall");
      expect(await eventually(async () => dropped, Boolean)).toBe(true);
      fault = "none";
      await view.until("Recovered stall");
      expect(subscriptions).toBeGreaterThan(before);
      expect(local.reachable()).toContain(node);
      expect(view.updates.some((update) => update.syncing)).toBe(true);
    } finally {
      fault = "none";
      await view.close();
    }
  }, 15_000);

  test("an event sequence gap replaces the base with an authoritative snapshot", async () => {
    const view = await follow();

    try {
      await view.until("Recovered stall");
      const before = subscriptions;
      fault = "gap";
      dropped = false;
      await b.api.sendMessage({ threadId: thread, text: "After a missed event", clientRequestId: crypto.randomUUID() });
      expect(
        await eventually(
          async () => subscriptions,
          (count) => count > before,
          5000,
        ),
      ).toBeGreaterThan(before);
      expect(dropped).toBe(true);
      expect(view.failure).toBeUndefined();
      expect(await eventually(async () => view.state?.turns.some((turn) => turn.status === "completed"), Boolean)).toBe(
        true,
      );
    } finally {
      fault = "none";
      await view.close();
    }
  }, 15_000);

  test("missing heartbeats expire an otherwise open watch and repair it without a client reconnect", async () => {
    const view = await follow(24);

    try {
      await view.until("Recovered stall");
      const before = subscriptions;
      const updates = view.updates.length;
      fault = "stall";
      await title("Heartbeat recovered");
      await view.until("Heartbeat recovered");
      expect(subscriptions).toBeGreaterThan(before);
      expect(view.updates.slice(updates).some((update) => update.syncing)).toBe(true);
      expect(local.reachable()).toContain(node);
    } finally {
      fault = "none";
      await view.close();
      await title("Recovered stall");
    }
  }, 15_000);

  test("durable revisions repair metadata missed by fan-out while watch heartbeats remain healthy", async () => {
    const view = await follow(24);

    try {
      await view.until("Recovered stall");
      const before = subscriptions;
      fault = "fanout";
      await store.query("UPDATE threads SET title='Durable revision recovered' WHERE id=$1::uuid", [thread]);
      await view.until("Durable revision recovered");
      expect(subscriptions).toBeGreaterThan(before);
    } finally {
      fault = "none";
      await view.close();
      await title("Recovered stall");
    }
  }, 15_000);

  test("a mismatched incremental base forces a full snapshot", async () => {
    const view = await follow(24);

    try {
      await view.until("Recovered stall");
      const before = subscriptions;
      fault = "base";
      await title("Base repaired");
      expect(
        await eventually(
          async () => subscriptions,
          (count) => count > before + 1,
          5000,
        ),
      ).toBeGreaterThan(before + 1);
      await view.until("Base repaired");
      expect(view.failure).toBeUndefined();
    } finally {
      fault = "none";
      await view.close();
      await title("Recovered stall");
    }
  }, 15_000);

  test("a reachable home that cannot provide a fresh snapshot reports a computer-scoped failure", async () => {
    const view = await follow(24);

    try {
      await view.until("Recovered stall");
      fault = "all";
      expect(await eventually(async () => Boolean(view.failure), Boolean, 5000)).toBe(true);
      expect(view.failure).toBeInstanceOf(ConnectError);
      expect(view.failure).toMatchObject({ code: Code.Unavailable });

      if (view.failure instanceof ConnectError)
        expect(view.failure.metadata.get("canopy-error-scope")).toBe("computer");
      expect(view.updates.at(-1)?.syncing).toBe(true);
      expect(local.reachable()).toContain(node);
    } finally {
      fault = "none";
      await view.close();
    }
  }, 15_000);

  test("reopening a stalled thread obtains fresh home state despite a stale mirror", async () => {
    mirrorStalled = true;
    const view = await follow(24);

    try {
      await view.until("Recovered stall");
      fault = "stall";
      dropped = false;
      await title("Reopened latest");
      expect(await eventually(async () => dropped, Boolean)).toBe(true);
      await view.close();
      fault = "none";
      const reopened = await follow(24, view.state?.cursor, view.state);

      try {
        await reopened.until("Reopened latest");
      } finally {
        await reopened.close();
      }
    } finally {
      fault = "none";
      mirrorStalled = false;
      await view.close();
    }
  }, 15_000);

  test("a missing background mirror checkpoint triggers a fresh generation", async () => {
    const before = mirrorSubscriptions;
    const generation = (await local.mirror.state(node))!.generation;
    mirrorStalled = true;
    dropped = false;

    try {
      await title("Mirror recovered");
      expect(await eventually(async () => dropped, Boolean)).toBe(true);
      mirrorStalled = false;
      expect(
        await eventually(
          async () => (await local.mirror.snapshot(node, thread))?.thread?.title,
          (value) => value === "Mirror recovered",
          5000,
        ),
      ).toBe("Mirror recovered");
      expect(mirrorSubscriptions).toBeGreaterThan(before);
      expect((await local.mirror.state(node))!.generation).not.toBe(generation);
    } finally {
      mirrorStalled = false;
    }
  }, 15_000);

  test("a stalled mirror reports unreachable until a fresh generation commits over the healthy link", async () => {
    mirrorStalled = true;

    try {
      expect(
        await eventually(
          async () => (await local.computer(node))?.status,
          (status) => status === "unreachable",
          5000,
        ),
      ).toBe("unreachable");
      expect(local.reachable()).toContain(node);
      expect((await local.mirror.snapshot(node, thread))?.thread?.title).toBe("Mirror recovered");
      mirrorStalled = false;
      expect(
        await eventually(
          async () => (await local.computer(node))?.status,
          (status) => status === "connected",
          5000,
        ),
      ).toBe("connected");
    } finally {
      mirrorStalled = false;
    }
  }, 15_000);

  test("an idle mirror clears a stream failure after its checkpoint is revalidated without a new commit", async () => {
    const state = (await local.mirror.state(node))!;
    mirrorError = true;
    expect(
      await eventually(
        async () => (await local.computer(node))?.status,
        (status) => status === "unreachable",
        5000,
      ),
    ).toBe("unreachable");
    expect(
      await eventually(
        async () => (await local.computer(node))?.status,
        (status) => status === "connected",
        5000,
      ),
    ).toBe("connected");
    expect((await local.mirror.state(node))!.cursor).toBe(state.cursor);
    expect((await local.mirror.state(node))!.generation).toBe(state.generation);
  }, 15_000);

  test("an older home without heartbeat frames is periodically revalidated", async () => {
    await home.close();
    home = linkedComputers({
      store,
      host: "127.0.0.1",
      heartbeatMs: 100,
      capabilities: ["presence", "unlink", REMOTE_THREADS, THREAD_MIRROR],
      serve: remoteServe(uiHandlers(b.core)),
    });
    b.core.computers = home;
    b.core.network = home.options.network;
    await home.start();
    expect(await eventually(async () => local.reachable().includes(node), Boolean, 15_000)).toBe(true);
    const view = await follow(24);

    try {
      await view.until("Mirror recovered");
      const before = subscriptions;
      fault = "stall";
      dropped = false;
      await title("Legacy recovered");
      expect(await eventually(async () => dropped, Boolean)).toBe(true);
      fault = "none";
      await view.until("Legacy recovered");
      expect(subscriptions).toBeGreaterThan(before);
    } finally {
      fault = "none";
      await view.close();
    }
  }, 30_000);

  test("healthy aggregate list polls use the live cache without consulting mirror histories", async () => {
    const request = create(ui.ListThreadsRequestSchema);
    expect(
      await eventually(async () => {
        await a.api.listThreads(request);

        return local.reads.state(node, ui.GatewayService.method.listThreads, request) === "fresh";
      }, Boolean),
    ).toBe(true);
    const list = local.mirror.threads.bind(local.mirror);
    local.mirror.threads = async () => {
      throw new Error("Mirror listing must not be used for a healthy cached list");
    };

    try {
      for (let poll = 0; poll < 3; poll++)
        expect((await a.api.listThreads(request)).threads.some((t) => t.id === qualifyId(thread, node))).toBe(true);
    } finally {
      local.mirror.threads = list;
    }
  });
});
