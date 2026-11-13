import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toBinary } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { startTestGateway } from "./support/gateway.ts";

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
