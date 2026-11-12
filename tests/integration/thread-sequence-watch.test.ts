import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { ItemSchema, ItemStatus, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { prependThreadPage } from "@canopy/domain/history-pages";
import { loadThreadItem } from "@canopy/domain/thread-content";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { SERVICE_TOKEN, startTestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bounded client sequence watch over real gRPC", () => {
  let gateway: Awaited<ReturnType<typeof startTestGateway>>;
  let store: ComputerStore;
  let thread: string;
  let cached: ui.ThreadSnapshot;
  let network: NetworkAccess;
  let unmount: () => void;
  let phone: ReturnType<typeof routedMobileClient>;
  beforeAll(async () => {
    gateway = await startTestGateway({ watchProbeMs: 100 });
    store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    const project = (await gateway.api.createProject({ name: "Client sequence windows" })).project!.id;

    const workspace = (
      await gateway.api.createWorkspace({
        projectId: project,
        workerId: gateway.workerId,
        rootPath: "/repo/client-sequences",
      })
    ).workspace!.id;

    thread = (
      await gateway.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        title: "Large client history",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;

    const item = create(ItemSchema, {
      status: ItemStatus.COMPLETED,
      content: { case: "commandExecution", value: { command: "bun test", output: "x".repeat(32700) } },
    });

    await store.query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      SELECT $1::uuid,'item-' || n,'commandExecution','completed',$2::jsonb || jsonb_build_object('itemId','item-' || n),n,n FROM generate_series(1,2000) n`,
      [thread, JSON.stringify(toJson(ItemSchema, item))],
    );
    await store.query("UPDATE threads SET last_seq=2000 WHERE id=$1::uuid", [thread]);
    network = new NetworkAccess({ store, host: "127.0.0.1" });
    gateway.core.network = network;
    unmount = mountMobileNetwork(gateway.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
    const routes = gateway.core.mobile.networkRoutes();
    const transport = nodePinnedTransport();
    const invite = await gateway.api.createMobilePairing({});

    const paired = await routedMobileClient({ connection: routes, transport }).pairing.exchangeMobilePairing({
      code: invite.code,
      name: "Sequence phone",
      platform: "android",
    });

    phone = routedMobileClient({ connection: routes, transport, token: paired.deviceToken });
  }, 20_000);
  afterAll(async () => {
    unmount?.();
    await network?.close();
    await gateway?.close();
  });
  test("a large thread paints a bounded recent window with lazy output", async () => {
    const update = await first({ threadId: thread, sequence: true, pageSize: 24 });
    expect(update.change.case).toBe("snapshot");
    cached = applyThreadUpdate(undefined, update);
    expect(cached.items.length).toBe(128);
    expect(cached.historyItemsHasMore).toBe(true);
    expect(cached.items[0]?.item?.itemId).toBe("item-1873");
    expect(cached.items.every((item) => item.contentRef?.sizeBytes)).toBe(true);
    expect(toBinary(ui.ThreadSnapshotSchema, cached).length).toBeLessThan(600 * 1024);
    expect(cached.syncCursor?.appliedSeq).toBeGreaterThanOrEqual(2000n);
  });
  test("the mobile binary Connect transport receives the same bounded window", async () => {
    const abort = new AbortController();

    try {
      for await (const update of phone.api.watchThread(
        { threadId: thread, sequence: true, pageSize: 24 },
        {
          signal: abort.signal,
          timeoutMs: 5000,
        },
      )) {
        const state = applyThreadUpdate(undefined, update);
        expect(state.items.length).toBe(128);
        expect(state.syncCursor?.epoch).toBe(cached.syncCursor?.epoch);
        expect(toBinary(ui.ThreadSnapshotSchema, state).length).toBeLessThan(600 * 1024);
        break;
      }

      expect((await phone.api.getThread({ threadId: thread })).thread?.id).toBe(thread);
    } finally {
      abort.abort();
    }
  });
  test("reconnect resumes from the cached sequence and replays no snapshot", async () => {
    cached = fromBinary(ui.ThreadSnapshotSchema, toBinary(ui.ThreadSnapshotSchema, cached));
    const abort = new AbortController();

    const watch = gateway.api.watchThread(
      { threadId: thread, sequence: true, syncCursor: cached.syncCursor },
      { signal: abort.signal },
    );

    try {
      await gateway.api.updateThread({ threadId: thread, title: "Resumed by durable sequence" });

      for await (const update of watch) {
        expect(update.change.case).not.toBe("snapshot");
        cached = applyThreadUpdate(cached, update);

        if (cached.thread?.title === "Resumed by durable sequence") break;
      }

      expect(cached.thread?.title).toBe("Resumed by durable sequence");
    } finally {
      abort.abort();
    }
  }, 5000);
  test("concurrent readers resume independently when another viewer cancels", async () => {
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const title = "Parallel viewers keep their durable cursors";
    const ready = controllers.map(() => Promise.withResolvers<void>());

    const readers = controllers.map(async (controller, index) => {
      let state = fromBinary(ui.ThreadSnapshotSchema, toBinary(ui.ThreadSnapshotSchema, cached));

      try {
        for await (const update of gateway.api.watchThread(
          { threadId: thread, sequence: true, syncCursor: state.syncCursor },
          { signal: controller.signal, timeoutMs: 5000 },
        )) {
          ready[index]!.resolve();
          expect(update.change.case).not.toBe("snapshot");
          state = applyThreadUpdate(state, update);

          if (state.thread?.title === title) return state;
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      }

      return state;
    });

    try {
      await Promise.all(ready.map((entry) => entry.promise));
      controllers[0]!.abort();
      await gateway.api.updateThread({ threadId: thread, title });
      const states = await Promise.all(readers);

      for (const state of states.slice(1)) {
        expect(state.thread?.title).toBe(title);
        expect(state.syncCursor?.appliedSeq).toBeGreaterThan(cached.syncCursor!.appliedSeq);
      }

      cached = states[1]!;
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.allSettled(readers);
    }
  });
  test("a fresh viewer detects durable edits made without a local notification", async () => {
    const abort = new AbortController();

    const held = gateway.api
      .watchThread({ threadId: thread, sequence: true }, { signal: abort.signal, timeoutMs: 5000 })
      [Symbol.asyncIterator]();

    try {
      const initial = await held.next();
      expect(initial.value?.change.case).toBe("snapshot");
      await store.query("UPDATE threads SET title='Changed by another gateway' WHERE id=$1::uuid", [thread]);
      const update = await first({ threadId: thread, sequence: true });
      cached = applyThreadUpdate(undefined, update);
      expect(cached.thread?.title).toBe("Changed by another gateway");
      expect(cached.items.length).toBe(128);
    } finally {
      abort.abort();
      await held.return?.();
    }
  });
  test("a stale epoch resets to a bounded window instead of repeating its cursor", async () => {
    const update = await first({
      threadId: thread,
      sequence: true,
      syncCursor: { threadId: thread, epoch: crypto.randomUUID(), appliedSeq: 999999n },
    });

    expect(update.change.case).toBe("snapshot");
    const state = applyThreadUpdate(undefined, update);
    expect(state.syncCursor?.epoch).toBe(cached.syncCursor?.epoch);
    expect(state.items.length).toBe(128);
  });
  test("large content loads in bounded owner-scoped chunks only on demand", async () => {
    const reference = cached.items.at(-1)!.contentRef!;
    let reads = 0;

    const item = await loadThreadItem(
      reference,
      async (offset, length) => {
        reads++;

        const chunk = await gateway.api.getThreadSyncContent({
          threadId: thread,
          sha256: reference.sha256,
          offset,
          length,
        });

        expect(chunk.data.length).toBeLessThanOrEqual(48 * 1024);

        return chunk;
      },
      new AbortController().signal,
    );

    expect(reads).toBeGreaterThan(0);
    expect(item.content.case).toBe("commandExecution");

    if (item.content.case === "commandExecution") expect(item.content.value.output.length).toBe(32700);
  });
  test("paging rewinds the sequence so concurrent edits cannot be lost", async () => {
    const checkpoint = cached.cursor;

    const page = applyThreadUpdate(
      undefined,
      await first({
        threadId: thread,
        sequence: true,
        beforeItemId: cached.historyBeforeItemId,
      }),
    );

    const cursor = cached.syncCursor!;
    const newer = { ...cached, syncCursor: { ...cursor, appliedSeq: cursor.appliedSeq + 1n } };
    expect(prependThreadPage(newer, page, checkpoint).syncCursor?.appliedSeq).toBe(cursor.appliedSeq);
  });
  test("a huge single turn retains supporting metadata and pages its items independently", async () => {
    const turn = crypto.randomUUID();
    await store.query(
      `INSERT INTO turns(id,thread_id,ordinal,status,trigger,author_user_id,input,first_seq,last_seq)
      VALUES($1::uuid,$2::uuid,1,'completed','user',$3::uuid,$4::jsonb,1,2000)`,
      [turn, thread, gateway.userId, JSON.stringify({ text: "Large input ".repeat(4000) })],
    );
    await store.query("UPDATE thread_items SET turn_id=$2::uuid WHERE thread_id=$1::uuid", [thread, turn]);
    const state = applyThreadUpdate(undefined, await first({ threadId: thread, sequence: true }));
    expect(state.items.length).toBeGreaterThan(0);
    expect(state.items.every((item) => state.turns.some((entry) => entry.id === item.turnId))).toBe(true);
    expect(toBinary(ui.ThreadSnapshotSchema, state).length).toBeLessThan(600 * 1024);

    const page = applyThreadUpdate(
      undefined,
      await first({
        threadId: thread,
        sequence: true,
        beforeTurnId: state.historyBeforeTurnId,
        beforeItemId: state.historyBeforeItemId,
      }),
    );

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.turns.some((entry) => entry.id === turn)).toBe(true);
    cached = state;
  });
  test("item pages reach all history even without turn boundaries", async () => {
    let page = cached;
    const ids = new Set(page.items.map((item) => item.item!.itemId));

    while (page.historyItemsHasMore) {
      const update = await first({
        threadId: thread,
        sequence: true,
        pageSize: 24,
        beforeItemId: page.historyBeforeItemId,
        historyVersion: page.historyVersion,
      });

      page = applyThreadUpdate(undefined, update);
      expect(page.items.length).toBeGreaterThan(0);

      for (const item of page.items) {
        expect(ids.has(item.item!.itemId)).toBe(false);
        ids.add(item.item!.itemId);
      }
    }

    expect(ids.size).toBe(2000);
  }, 15_000);

  async function first(input: Parameters<typeof create<typeof ui.WatchThreadRequestSchema>>[1]) {
    const abort = new AbortController();

    try {
      for await (const update of gateway.api.watchThread(create(ui.WatchThreadRequestSchema, input), {
        signal: abort.signal,
        timeoutMs: 5000,
      }))
        return update;
      throw new Error("Missing window");
    } finally {
      abort.abort();
    }
  }
});
