import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDirs } from "@canopy/testing";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { ThreadCache } from "@canopy/domain/thread-cache";
import { ThreadWarmer } from "@canopy/domain/thread-warmer";
import { threadCacheCurrent, threadWarmSet, THREAD_WARM_LIMITS } from "@canopy/domain/thread-warm-set";
import { sidebarThreads } from "@canopy/domain/sidebar-threads";
import { threadSortModes } from "@canopy/domain/thread-order";
import { overviewThreadHeads } from "../../apps/gateway/src/core/overview-thread-heads.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { startTestGateway, eventually } from "./support/gateway.ts";
import { PersistentThreadCache } from "../../apps/mobile/src/storage/thread-cache.ts";
import { DiskThreadStorage } from "./support/thread-cache.ts";

const directory = tempDirs();

describe.skipIf(!dockerAvailable)("background thread sequence reads", () => {
  let gateway: Awaited<ReturnType<typeof startTestGateway>>;
  let store: ComputerStore;
  let id: string;
  let base: ui.ThreadSnapshot;
  beforeAll(async () => {
    gateway = await startTestGateway();
    store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
    const project = (await gateway.api.createProject({ name: "Warm threads" })).project!.id;

    const workspace = (
      await gateway.api.createWorkspace({ projectId: project, workerId: gateway.workerId, rootPath: "/repo/warming" })
    ).workspace!.id;

    id = (
      await gateway.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        title: "Before",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;
    base = applyThreadUpdate(undefined, (await warm())[0]!);
  }, 20_000);
  afterAll(async () => {
    await gateway?.close();
  });

  test("overview multiplexes owner-scoped heads and detects changes without a thread watch", async () => {
    const foreign = crypto.randomUUID();
    await store.query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other owner','user')", [
      foreign,
      `${foreign}@example.test`,
    ]);
    const hidden = crypto.randomUUID();
    await store.query(
      `INSERT INTO threads(id,root_thread_id,owner_user_id,project_id,kind,runtime,provider,worker_id,workspace_id,cwd,status)
        SELECT $1::uuid,$1::uuid,$2::uuid,project_id,'main',runtime,provider,worker_id,workspace_id,cwd,'idle'
        FROM threads WHERE id=$3::uuid`,
      [hidden, foreign, id],
    );
    const abort = new AbortController();
    const seen: bigint[] = [];

    try {
      for await (const update of gateway.api.watchOverview(
        { threadHeadIds: [id, hidden] },
        { signal: abort.signal, timeoutMs: 7000 },
      )) {
        if (update.change.case !== "threadHeads") continue;
        expect(update.change.value.heads.map((head) => head.threadId)).toEqual([id]);
        const head = update.change.value.heads[0]!;
        expect(head.epoch).toBe(base.syncCursor!.epoch);
        seen.push(head.appliedSeq);

        if (seen.length === 2) break;

        // Seal any worker-ready edits before asking for another revision of the same header.
        for (const delta of await warm(base)) base = applyThreadUpdate(base, delta);
        await gateway.api.updateThread({ threadId: id, title: "Changed outside the thread" });
      }
    } finally {
      abort.abort();
    }

    expect(seen.length).toBe(2);
    expect(seen[1]!).toBeGreaterThan(seen[0]!);
  }, 10_000);

  test("reopening and reconnecting resume only deltas from the cached sequence", async () => {
    const updates = await warm(base);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((update) => update.change.case === "batch")).toBe(true);

    for (const update of updates) {
      expect(toBinary(ui.ThreadUpdateSchema, update).length).toBeLessThan(66 * 1024);
      base = applyThreadUpdate(base, update);
    }

    expect(base.thread?.title).toBe("Changed outside the thread");
    await gateway.api.updateThread({ threadId: id, title: "After reconnect" });

    for (const update of await warm(base)) {
      expect(update.change.case).toBe("batch");
      base = applyThreadUpdate(base, update);
    }

    expect(base.thread?.title).toBe("After reconnect");
  });

  test("a distant cache gets only the latest bounded tail with older history pageable", async () => {
    await store.query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      SELECT $1::uuid,'warm-' || n,'agentMessage','completed',jsonb_build_object('itemId','warm-' || n,'agentMessage',jsonb_build_object('text','message ' || n)),n,n
      FROM generate_series(1,2000) n`,
      [id],
    );
    const updates = await warm(base);
    expect(updates.length).toBe(1);
    expect(updates[0]!.change.case).toBe("snapshot");
    const tail = applyThreadUpdate(undefined, updates[0]!);
    expect(tail.items.length).toBeLessThanOrEqual(128);
    expect(tail.items.at(-1)?.item?.itemId).toBe("warm-2000");
    expect(tail.historyItemsHasMore).toBe(true);
    expect(tail.historyBeforeItemId).toBeTruthy();
    expect(toBinary(ui.ThreadSnapshotSchema, tail).length).toBeLessThan(600 * 1024);
  });

  test("recent warming follows replies and filters across created and manual sidebar order", async () => {
    const added: ui.Thread[] = [];

    for (const title of ["Warm order first", "Warm order reply", "Warm order newest"]) {
      const thread = (
        await gateway.api.createThread({
          projectId: base.thread!.projectId,
          workspaceId: base.thread!.workspaceId,
          provider: Provider.CODEX,
          title,
        })
      ).thread!;

      added.push(thread);
    }

    const [first, reply, newest] = added;
    await eventually(
      () => gateway.api.getThread({ threadId: reply!.id }),
      (r) => r.thread?.status === "idle",
    );
    await gateway.api.sendMessage({
      threadId: reply!.id,
      text: "A recent reply",
      clientRequestId: crypto.randomUUID(),
    });
    await eventually(
      () => gateway.api.getThread({ threadId: reply!.id }),
      (r) => !!r.thread?.lastReplyAt && r.thread.status === "idle",
    );
    await gateway.api.reorderThread({ threadId: first!.id, beforeThreadId: newest!.id });
    const threads = (await gateway.api.listThreads({})).threads;
    const settings = create(ui.SidebarSettingsSchema);
    const limits = { ...THREAD_WARM_LIMITS, recent: 1, count: 1 };
    const firstBySort = { custom: first!.id, created: newest!.id, activity: reply!.id };

    for (const mode of threadSortModes) {
      const roots = sidebarThreads(threads, settings, "Warm order", () => "", mode.value).roots;
      expect(roots[0]?.id).toBe(firstBySort[mode.value]);
      expect(
        threadWarmSet(
          threads,
          [],
          roots.map((thread) => thread.id),
          limits,
        ),
      ).toEqual([reply!.id]);
    }

    const roots = sidebarThreads(threads, settings, "Warm order first", () => "", "custom").roots;
    expect(
      threadWarmSet(
        threads,
        [],
        roots.map((thread) => thread.id),
        limits,
      ),
    ).toEqual([first!.id]);
    expect(
      threadWarmSet(
        threads,
        [newest!.id],
        roots.map((thread) => thread.id),
        { ...limits, count: 3 },
      ),
    ).toEqual([first!.id, reply!.id, newest!.id]);
  });

  test("the bounded warmer coalesces heads into a current memory tail and yields to the visible thread", async () => {
    const cache = new ThreadCache({ count: 2, bytes: 1024 * 1024 });
    const kinds: string[] = [];

    const warmer = new ThreadWarmer(
      { peek: (key) => cache.peek(key), load: async (key) => cache.get(key), save: (snapshot) => cache.set(snapshot) },
      async function* (key, cursor, signal) {
        for await (const update of gateway.api.watchThread(
          { threadId: key, sequence: true, background: true, syncCursor: cursor },
          { signal },
        )) {
          kinds.push(update.change.case ?? "");
          yield update;
        }
      },
      { ...THREAD_WARM_LIMITS, intervalMs: 20, requested: () => {} },
    );

    try {
      warmer.select([id]);
      const initial = await overviewThreadHeads(gateway.core, [id]);
      warmer.heads(initial.heads);
      warmer.enable(true);
      await eventually(
        async () => cache.peek(id),
        (snapshot) => !!snapshot?.syncCursor,
      );
      expect(cache.peek(id)?.items.length).toBeLessThanOrEqual(128);
      expect(cache.usage.bytes).toBeLessThanOrEqual(cache.limits.bytes);
      expect(warmer.requests).toBe(1);
      warmer.activate(id);
      kinds.length = 0;
      await gateway.api.updateThread({ threadId: id, title: "Ready in the background" });
      const next = await overviewThreadHeads(gateway.core, [id]);
      warmer.heads(next.heads);
      warmer.heads(next.heads);
      expect(warmer.requests).toBe(1);
      warmer.activate("");
      expect(
        await eventually(
          async () => cache.peek(id)?.thread?.title,
          (title) => title === "Ready in the background",
        ),
      ).toBe("Ready in the background");
      expect(kinds.every((kind) => kind === "batch")).toBe(true);
      expect(warmer.requests).toBe(2);
      expect(threadCacheCurrent(cache.peek(id), next.heads[0])).toBe(true);
    } finally {
      warmer.close();
    }
  });

  test("a mobile restart warms only deltas from its durable checkpoint and pauses without losing progress", async () => {
    const disk = new DiskThreadStorage(directory("canopy-warm-mobile-"));
    const original = new PersistentThreadCache(disk);
    let checkpoint: ui.ThreadSnapshot | undefined;

    for (const update of await warm()) checkpoint = applyThreadUpdate(checkpoint, update);
    await original.save(checkpoint!);
    const restarted = new PersistentThreadCache(disk);
    expect(restarted.peek(id)).toBeUndefined();
    await gateway.api.updateThread({ threadId: id, title: "While the phone was away" });
    const heads = await overviewThreadHeads(gateway.core, [id]);
    const kinds: string[] = [];

    const warmer = new ThreadWarmer(restarted, async function* (key, syncCursor, signal) {
      for await (const update of gateway.api.watchThread(
        { threadId: key, syncCursor, sequence: true, background: true },
        { signal },
      )) {
        kinds.push(update.change.case ?? "");
        yield update;
      }
    });

    try {
      warmer.select([id]);
      warmer.heads(heads.heads);
      expect(warmer.requests).toBe(0);
      warmer.enable(true);
      await eventually(async () => threadCacheCurrent(restarted.peek(id), heads.heads[0]), Boolean);
      warmer.enable(false);
      expect(kinds.length).toBeGreaterThan(0);
      expect(kinds.every((kind) => kind === "batch")).toBe(true);
      expect(restarted.usage.bytes).toBeLessThanOrEqual(24 * 1024 * 1024);
      await restarted.load(id);
      const diskOnly = new PersistentThreadCache(disk);
      expect((await diskOnly.load(id))?.thread?.title).toBe("While the phone was away");
      await diskOnly.close();
    } finally {
      warmer.close();
      await restarted.close();
      await original.close();
    }
  });

  async function warm(snapshot?: ui.ThreadSnapshot) {
    const updates: ui.ThreadUpdate[] = [];

    for await (const update of gateway.api.watchThread(
      { threadId: id, sequence: true, background: true, syncCursor: snapshot?.syncCursor },
      { timeoutMs: 5000 },
    ))
      updates.push(update);

    return updates;
  }
});
