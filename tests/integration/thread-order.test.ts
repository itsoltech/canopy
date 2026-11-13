import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { compareThreadOrder } from "@canopy/domain/thread-order";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("durable manual thread order", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;
  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Thread order" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  const add = async (title: string) =>
    (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title })).thread!;

  const list = async () => (await gw.api.listThreads({})).threads.sort((a, b) => compareThreadOrder(a, b, "custom"));

  test("new threads start above a moved thread; a move changes only one key and survives reload", async () => {
    const a = await add("First");
    const b = await add("Second");
    const c = await add("Third");
    expect((await list()).map((t) => t.id)).toEqual([c.id, b.id, a.id]);
    const before = await list();
    const moved = (await gw.api.reorderThread({ threadId: a.id, afterThreadId: c.id, beforeThreadId: b.id })).thread!;
    expect(moved.sidebarOrderKey > c.sidebarOrderKey && moved.sidebarOrderKey < b.sidebarOrderKey).toBe(true);
    expect((await list()).map((t) => t.id)).toEqual([c.id, a.id, b.id]);
    expect((await list()).filter((t) => t.id !== a.id).map((t) => t.sidebarOrderKey)).toEqual(
      before.filter((t) => t.id !== a.id).map((t) => t.sidebarOrderKey),
    );
    const d = await add("Newest");
    expect((await list())[0]?.id).toBe(d.id);
    expect((await gw.api.getThread({ threadId: a.id })).thread?.sidebarOrderKey).toBe(moved.sidebarOrderKey);
  });

  test("owner scoping, self references, stale reversed bounds and archived anchors are rejected without writes", async () => {
    const a = await add("Validation A");
    const b = await add("Validation B");
    const foreign = Bun.randomUUIDv7();
    expect(
      await failure(
        gw.runtime.runPromise(
          GatewayStore.use((s) => s.reorderThread(foreign, create(ui.ReorderThreadRequestSchema, { threadId: a.id }))),
        ),
      ),
    ).toContain("unavailable");
    expect(await failure(gw.api.reorderThread({ threadId: a.id, beforeThreadId: a.id }))).toContain("different");
    expect(await failure(gw.api.reorderThread({ threadId: "bad" }))).toContain("different");
    expect(await failure(gw.api.reorderThread({ threadId: a.id, beforeThreadId: foreign }))).toContain("unavailable");
    const otherProject = (await gw.api.createProject({ name: "Other order group" })).project!.id;

    const otherWorkspace = (
      await gw.api.createWorkspace({ projectId: otherProject, workerId: gw.workerId, rootPath: "/other" })
    ).workspace!.id;

    const other = (
      await gw.api.createThread({
        projectId: otherProject,
        workspaceId: otherWorkspace,
        provider: Provider.CODEX,
        title: "Other group",
      })
    ).thread!;

    expect(
      await failure(gw.api.reorderThread({ threadId: a.id, beforeThreadId: other.id, withinProject: true })),
    ).toContain("same project");
    const c = await add("Validation C");
    expect(
      await failure(gw.api.reorderThread({ threadId: a.id, afterThreadId: b.id, beforeThreadId: c.id })),
    ).toContain("changed elsewhere");
    await gw.api.setThreadArchived({ threadId: b.id, archived: true });
    expect(await failure(gw.api.reorderThread({ threadId: a.id, beforeThreadId: b.id }))).toContain("unavailable");
    expect((await gw.api.getThread({ threadId: a.id })).thread?.sidebarOrderKey).toBe(a.sidebarOrderKey);
  });

  test("many edge insertions keep short keys while densely split gaps remain ordered", async () => {
    const result = await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        const edges = yield* sql<{ count: number; size: number }>`WITH RECURSIVE ranks(n, lo, hi) AS (
        VALUES (0, 'a0'::text, 'a0'::text)
        UNION ALL SELECT n + 1, thread_order_between(NULL, lo), thread_order_between(hi, NULL)
          FROM ranks WHERE n < 10000
      ) SELECT count(*)::int AS count, greatest(max(length(lo)), max(length(hi)))::int AS size FROM ranks`;

        const gaps = yield* sql<{ key: string }>`WITH RECURSIVE ranks(n, key) AS (
        VALUES (0, thread_order_between('a0', 'a1'))
        UNION ALL SELECT n + 1, thread_order_between(key, 'a1') FROM ranks WHERE n < 100
      ) SELECT key FROM ranks ORDER BY n`;

        return { edge: edges[0]!, keys: gaps.map((r) => r.key) };
      }),
    );

    expect(result.edge.count).toBe(10001);
    expect(result.edge.size).toBeLessThanOrEqual(5);
    expect(result.keys.every((key, i) => key > (result.keys[i - 1] ?? "a0") && key < "a1")).toBe(true);
    expect(new Set(result.keys).size).toBe(101);
  });

  test("old rows fall back to creation order and repeated and concurrent moves leave distinct fractional keys", async () => {
    const a = await add("Old A");
    const b = await add("Old B");
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE threads SET sidebar_order_key = NULL, created_at = '2026-01-01T00:00:00Z'::timestamptz
          WHERE id = ANY(${[a.id, b.id]}::uuid[])`;
      }),
    );
    const old = (await list()).filter((t) => t.id === a.id || t.id === b.id);
    expect(old.map((t) => t.id)).toEqual([b.id, a.id]);

    for (let i = 0; i < 35; i++) await gw.api.reorderThread({ threadId: a.id, beforeThreadId: b.id });
    const c = await add("Concurrent C");
    const d = await add("Concurrent D");
    await Promise.all([
      gw.api.reorderThread({ threadId: c.id, beforeThreadId: b.id }),
      gw.api.reorderThread({ threadId: d.id, beforeThreadId: b.id }),
    ]);
    const keys = (await list()).map((t) => t.sidebarOrderKey).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("only an agent reply advances reply ordering; creating and queueing have no reply time", async () => {
    const thread = await add("Reply time");
    expect(thread.lastReplyAt).toBeUndefined();
    await eventually(
      () => gw.api.getThread({ threadId: thread.id }),
      (r) => r.thread?.status === "idle",
    );
    await gw.api.sendMessage({ threadId: thread.id, text: "Reply", clientRequestId: "reply-time" });

    const result = await eventually(
      () => gw.api.getThread({ threadId: thread.id }),
      (r) => !!r.thread?.lastReplyAt,
    );

    expect(result.thread?.lastReplyAt).toBeDefined();
  });
});
