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
import { computersState } from "../../apps/gateway/src/computers/runtime-context.ts";
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
  let mirrorRecovery: Promise<void> | undefined;
  let dropped = false;
  let gapSequence = 0n;
  let heartbeats = 0;
  let subscriptions = 0;
  let mirrorSubscriptions = 0;
  const timing = { heartbeatMs: 100, timeoutMs: 1000, legacyProbeMs: 1500 };

  async function title(value: string) {
    await b.api.updateThread({ threadId: thread, title: value });
  }

  async function follow(pageSize = 0, cursor = "", base?: ui.ThreadSnapshot, localHome = false) {
    const abort = new AbortController();
    const updates: ui.ThreadUpdate[] = [];
    let state = base;
    let live = false;
    let failure: unknown;

    const done = (async () => {
      try {
        for await (const update of (localHome ? b : a).api.watchThread(
          { threadId: localHome ? thread : qualifyId(thread, node), pageSize, incremental: !!pageSize, cursor },
          { signal: abort.signal },
        )) {
          updates.push(update);
          state = applyThreadUpdate(state, update);

          if (!update.syncing && (update.change.case === "snapshot" || update.change.case === "delta")) live = true;
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
            // The mirror seed is readable before the home watch is subscribed.
            async () => (live ? state?.thread?.title : undefined),
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
    b = await startTestGateway({ role: "desktop", watchProbeMs: 100 });
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
      // Exercise application expiry before the independent physical link can expire.
      heartbeatMs: timing.timeoutMs,
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

        if (args[1].name === "WatchThreadMirror") await mirrorRecovery;

        if (watching) {
          if (fault === "all" || (fault === "stall" && seeded)) {
            dropped = true;
            continue;
          }

          const update = linkedMessage(ui.ThreadUpdateSchema, message);

          if (update.watchCursor) heartbeats++;

          if (fault === "fanout" && seeded && !update.watchCursor) {
            dropped = true;
            continue;
          }

          if (fault === "gap") {
            // Hold revision recovery until a real missing event and its successor reach the viewer.
            if (update.change.case !== "event") continue;

            if (!dropped) {
              gapSequence = update.change.value.seq;
              dropped = true;
              continue;
            }

            fault = "none";
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
      expect(
        await eventually(
          async () => subscriptions,
          (count) => count > before,
        ),
      ).toBeGreaterThan(before);
      fault = "none";
      await view.until("Recovered stall");
      expect(local.reachable()).toContain(node);
      expect(view.updates.some((update) => update.syncing)).toBe(true);
    } finally {
      fault = "none";
      await view.close();
    }
  }, 15_000);

  test("local and linked watches ignore unrelated activity and already-scanned journal pruning", async () => {
    const source = (await b.api.getThread({ threadId: thread })).thread!;

    const other = (
      await b.api.createThread({
        projectId: source.projectId,
        workspaceId: source.workspaceId,
        provider: source.provider,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;

    const view = await follow(24);
    const localView = await follow(24, "", undefined, true);

    try {
      await view.until("Recovered stall");
      await localView.until("Recovered stall");
      const before = subscriptions;
      const beats = heartbeats;
      await b.api.updateThread({ threadId: other, title: "Busy unrelated thread" });

      const clock = (
        await store.query<{ revision: string }>(
          "SELECT revision::text FROM computer_thread_clock WHERE owner_user_id=$1::uuid",
          [b.userId],
        )
      )[0]!;

      expect(
        await eventually(
          async () => heartbeats,
          (count) => count >= beats + 3,
        ),
      ).toBeGreaterThanOrEqual(beats + 3);
      expect(subscriptions).toBe(before);
      await store.query("DELETE FROM computer_thread_changes WHERE owner_user_id=$1::uuid AND revision<=$2::bigint", [
        b.userId,
        clock.revision,
      ]);
      const scanned = heartbeats;
      expect(
        await eventually(
          async () => heartbeats,
          (count) => count >= scanned + 3,
        ),
      ).toBeGreaterThanOrEqual(scanned + 3);
      expect(subscriptions).toBe(before);
      expect(localView.updates.some((update) => update.syncing)).toBe(false);
      await store.query("UPDATE threads SET title='Shared revision repaired' WHERE id=$1::uuid", [thread]);
      await view.until("Shared revision repaired");
      await localView.until("Shared revision repaired");
      expect(localView.updates.some((update) => update.syncing)).toBe(true);
      expect(subscriptions).toBeGreaterThan(before);
    } finally {
      await view.close();
      await localView.close();
      await title("Recovered stall");
    }
  }, 15_000);

  test("a retained-journal gap conservatively revalidates a quiet watch", async () => {
    const view = await follow(24);

    try {
      await view.until("Recovered stall");
      const before = subscriptions;
      await store.query("UPDATE threads SET title='Gap revision repaired' WHERE id=$1::uuid", [thread]);
      await store.query("DELETE FROM computer_thread_changes WHERE owner_user_id=$1::uuid", [b.userId]);
      await view.until("Gap revision repaired");
      expect(subscriptions).toBeGreaterThan(before);
      expect(
        view.updates.some(
          (update) =>
            update.change.case === "snapshot" && update.change.value.thread?.title === "Gap revision repaired",
        ),
      ).toBe(true);
    } finally {
      await view.close();
      await title("Recovered stall");
    }
  }, 15_000);

  test("an event sequence gap replaces the base with an authoritative snapshot", async () => {
    const view = await follow(24);

    try {
      await view.until("Recovered stall");
      const before = subscriptions;
      fault = "gap";
      dropped = false;
      let turnId = "";

      // A home revision probe may cover a turn before its events reach this stream.
      // Drive activity until the transport has actually injected the event gap.
      expect(
        await eventually(
          async () => {
            if (fault !== "gap") return true;

            const sent = await b.api.sendMessage({
              threadId: thread,
              text: "After a missed event",
              clientRequestId: crypto.randomUUID(),
            });

            turnId = sent.turn!.id;

            return dropped && fault !== "gap";
          },
          Boolean,
          5000,
        ),
      ).toBe(true);
      expect(dropped).toBe(true);
      expect(
        await eventually(
          async () =>
            view.updates.some(
              (update) => update.change.case === "snapshot" && update.change.value.lastSeq >= gapSequence,
            ),
          Boolean,
        ),
      ).toBe(true);
      expect(subscriptions).toBeGreaterThan(before);
      expect(view.failure).toBeUndefined();
      expect(
        await eventually(
          async () =>
            view.state?.turns.some((turn) => turn.id === qualifyId(turnId, node) && turn.status === "completed"),
          Boolean,
        ),
      ).toBe(true);
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

  test("a reachable home that cannot provide a fresh snapshot reports a thread-scoped failure", async () => {
    const view = await follow(24);

    try {
      await view.until("Recovered stall");
      fault = "all";
      expect(await eventually(async () => Boolean(view.failure), Boolean, 5000)).toBe(true);
      expect(view.failure).toBeInstanceOf(ConnectError);
      expect(view.failure).toMatchObject({ code: Code.Unavailable });

      if (view.failure instanceof ConnectError) expect(view.failure.metadata.get("canopy-error-scope")).toBe("thread");
      expect(view.updates.at(-1)?.syncing).toBe(true);
      expect(view.state?.thread?.title).toBe("Recovered stall");
      expect((await local.computer(node))?.status).toBe("connected");
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
    const state = await eventually(
      async () => local.mirror.state(node),
      (value) => !!value?.cursor,
    );

    expect(state?.cursor).toBeTruthy();
    const before = mirrorSubscriptions;
    const generation = state!.generation;
    mirrorStalled = true;
    dropped = false;

    try {
      await title("Mirror recovered");
      expect(await eventually(async () => dropped, Boolean)).toBe(true);
      expect(
        await eventually(
          async () => (await local.mirror.state(node))?.cursor,
          (cursor) => cursor === "",
        ),
      ).toBe("");
      mirrorStalled = false;
      expect(
        await eventually(
          async () => (await local.mirror.snapshot(node, thread))?.thread?.title,
          (value) => value === "Mirror recovered",
          5000,
        ),
      ).toBe("Mirror recovered");
      expect(
        await eventually(
          async () => (await local.mirror.state(node))?.generation,
          (value) => !!value && value !== generation,
        ),
      ).not.toBe(generation);
      expect(mirrorSubscriptions).toBeGreaterThan(before);
      expect((await local.mirror.state(node))!.generation).not.toBe(generation);
    } finally {
      mirrorStalled = false;
    }
  }, 15_000);

  test("a stalled mirror keeps cached content and a healthy link until a fresh generation commits", async () => {
    mirrorStalled = true;

    try {
      expect(await eventually(async () => local[computersState].staleMirrors.has(node), Boolean, 5000)).toBe(true);
      expect((await local.computer(node))?.status).toBe("connected");
      expect(local.reachable()).toContain(node);
      expect((await local.mirror.snapshot(node, thread))?.thread?.title).toBe("Mirror recovered");
      mirrorStalled = false;
      expect(await eventually(async () => !local[computersState].staleMirrors.has(node), Boolean, 5000)).toBe(true);
      expect((await local.computer(node))?.status).toBe("connected");
    } finally {
      mirrorStalled = false;
    }
  }, 15_000);

  test("an idle mirror clears a stream failure after its checkpoint is revalidated without a new commit", async () => {
    const state = (await local.mirror.state(node))!;
    const recovery = Promise.withResolvers<void>();
    mirrorRecovery = recovery.promise;
    mirrorError = true;

    try {
      expect(await eventually(async () => !mirrorError, Boolean)).toBe(true);
      expect(await eventually(async () => local[computersState].staleMirrors.has(node), Boolean, 5000)).toBe(true);
      expect((await local.computer(node))?.status).toBe("connected");
      expect(local.reachable()).toContain(node);
      expect((await local.mirror.state(node))!.cursor).toBe(state.cursor);
      expect((await local.mirror.state(node))!.generation).toBe(state.generation);
      // Keep recovery pending until stale application state has been observed.
      mirrorRecovery = undefined;
      recovery.resolve();
      expect(await eventually(async () => !local[computersState].staleMirrors.has(node), Boolean, 5000)).toBe(true);
      expect((await local.computer(node))?.status).toBe("connected");
      expect((await local.mirror.state(node))!.cursor).toBe(state.cursor);
      expect((await local.mirror.state(node))!.generation).toBe(state.generation);
    } finally {
      mirrorError = false;
      mirrorRecovery = undefined;
      recovery.resolve();
    }
  }, 15_000);

  test("an older home without heartbeat frames is periodically revalidated", async () => {
    await home.close();
    home = linkedComputers({
      store,
      host: "127.0.0.1",
      heartbeatMs: timing.timeoutMs,
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
      expect(
        await eventually(
          async () => subscriptions,
          (count) => count > before,
        ),
      ).toBeGreaterThan(before);
      fault = "none";
      await view.until("Legacy recovered");
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
