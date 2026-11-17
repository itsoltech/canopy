import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { prependThreadPage } from "@canopy/domain/history-pages";
import { threadCacheTail } from "@canopy/domain/thread-cache-tail";
import { GatewayStore, SteerStore } from "@canopy/gateway/store";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("historical agent steers in client windows", () => {
  let gateway: TestGateway;
  let parentId: string;
  let parentTurnId: string;
  let childId: string;
  const messages = new Map<string, string>();

  const turns = (threadId: string) => gateway.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(threadId)));

  const steers = () => gateway.runtime.runPromise(SteerStore.use((store) => store.ofThread(parentId)));

  beforeAll(async () => {
    gateway = await startTestGateway();
    gateway.worker.holdTurns = true;
    const projectId = (await gateway.api.createProject({ name: "Historical steers" })).project!.id;

    const workspaceId = (
      await gateway.api.createWorkspace({ projectId, workerId: gateway.workerId, rootPath: "/repo/steer-windows" })
    ).workspace!.id;

    parentId = (await gateway.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "Parent" }))
      .thread!.id;
    parentTurnId = (await gateway.api.sendMessage({ threadId: parentId, text: "Coordinate the work" })).turn!.id;
    childId = (
      await gateway.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        parentThreadId: parentId,
        title: "Historical sender",
      })
    ).thread!.id;
    const childTurnId = (await gateway.api.sendMessage({ threadId: childId, text: "Report progress" })).turn!.id;

    for (const threadId of [parentId, childId]) {
      const running = await eventually(
        () => turns(threadId),
        (rows) => rows[0]?.status === "running",
      );

      expect(running[0]?.status).toBe("running");
    }

    for (let index = 0; index < 40; index++) {
      const result = await gateway.worker.callTool({
        threadId: childId,
        turnId: childTurnId,
        tool: "send_message",
        args: { thread_id: parentId, prompt: `Historical update ${index}`, delivery: "steer", notify: false },
      });

      expect(result.isError).toBe(false);
    }

    const delivered = await eventually(
      steers,
      (rows) => rows.length === 40 && rows.every((row) => row.status === "delivered"),
    );

    expect(delivered).toHaveLength(40);
    expect(delivered.every((row) => row.status === "delivered")).toBe(true);

    for (const row of delivered) messages.set(row.id, row.input.message!);
    gateway.worker.finish(childId, childTurnId, "Progress reported");
    gateway.worker.finish(parentId, parentTurnId, "All updates received");

    const completed = await eventually(
      () => turns(parentId),
      (rows) => rows[0]?.status === "completed",
    );

    expect(completed[0]?.status).toBe("completed");
  }, 60000);

  afterAll(async () => {
    await gateway?.close();
  });

  async function read(threadId: string, pageSize: number, base?: ui.ThreadSnapshot) {
    const abort = new AbortController();

    try {
      for await (const update of gateway.api.watchThread(
        {
          threadId,
          sequence: true,
          pageSize,
          beforeTurnId: base?.historyBeforeTurnId ?? "",
          beforeItemId: base?.historyBeforeItemId ?? "",
          historyVersion: base?.historyVersion ?? "",
        },
        { signal: abort.signal, timeoutMs: 15000 },
      )) {
        if (update.change.case === "snapshot") return update.change.value;
      }

      throw new Error("Missing client window");
    } finally {
      abort.abort();
    }
  }

  function assertSenders(snapshot: ui.ThreadSnapshot, inherited = false) {
    const selected = snapshot.items.filter((entry) => entry.item?.content.case === "userMessage");

    for (const entry of selected) {
      const content = entry.item!.content;

      if (content.case !== "userMessage") continue;
      const steer = snapshot.steers.find((candidate) => candidate.id === content.value.clientId);
      expect(messages.has(content.value.clientId)).toBe(true);
      expect(content.value.text).toContain("[canopy]");
      expect(steer).toMatchObject({
        text: messages.get(content.value.clientId),
        status: "delivered",
        sourceThreadId: childId,
        sender: { threadId: childId, title: "Historical sender", provider: Provider.CODEX },
      });
      expect(entry.inherited).toBe(inherited);

      if (inherited) expect(entry.fromThreadId).toBe(parentId);
    }

    return selected.length;
  }

  const persisted = (snapshot: ui.ThreadSnapshot) =>
    fromBinary(ui.ThreadSnapshotSchema, toBinary(ui.ThreadSnapshotSchema, threadCacheTail(snapshot)));

  async function assertPaging(threadId: string, inherited = false) {
    let state = await read(threadId, 1);
    expect(state.historyItemsHasMore).toBe(true);
    assertSenders(state, inherited);
    const checkpoint = state.cursor;

    for (let count = 0; state.historyItemsHasMore && count < 12; count++) {
      const page = await read(threadId, 1, state);
      expect(page.items.length).toBeLessThanOrEqual(6);
      expect(page.items.length).toBeGreaterThan(0);
      assertSenders(page, inherited);
      const previous = state.items.length;
      state = prependThreadPage(state, page, checkpoint);
      expect(state.items.length).toBeGreaterThan(previous);
      expect(state.cursor).toBe(checkpoint);
      assertSenders(state, inherited);
      assertSenders(persisted(state), inherited);
    }

    expect(state.historyItemsHasMore).toBe(false);
    expect(assertSenders(state, inherited)).toBe(40);
    expect(assertSenders(persisted(state), inherited)).toBe(40);
  }

  test("initial windows and persisted tails keep every selected steer beyond the recent 32", async () => {
    const snapshot = await read(parentId, 24);
    expect(assertSenders(snapshot)).toBe(40);
    expect(assertSenders(persisted(snapshot))).toBe(40);
  });

  test("paging older items merges their steer text and sender without changing the checkpoint", async () => {
    await assertPaging(parentId);
  });

  test("older pages cannot replace current steer text, status or sender metadata", async () => {
    const current = await read(parentId, 1);
    const page = await read(parentId, 1, current);
    const newer = current.steers.find((steer) => page.steers.some((older) => older.id === steer.id))!;
    const older = page.steers.find((steer) => steer.id === newer.id)!;
    older.text = "Stale historical text";
    older.status = "accepted";
    older.sender!.title = "Stale sender title";
    const merged = prependThreadPage(current, page);

    expect(merged.items.length).toBeGreaterThan(current.items.length);
    expect(merged.cursor).toBe(current.cursor);
    expect(merged.steers.filter((steer) => steer.id === newer.id)).toEqual([newer]);
    expect(persisted(merged).steers.find((steer) => steer.id === newer.id)).toEqual(newer);
    assertSenders(merged);
  });

  test("persisted tails budget selected items together with their required steer metadata", async () => {
    const snapshot = await read(parentId, 24);

    for (const steer of snapshot.steers) steer.text += `\n${"x".repeat(20 * 1024)}`;
    const restored = persisted(snapshot);

    expect(restored.items.length).toBeGreaterThan(0);
    expect(restored.items.length).toBeLessThan(snapshot.items.length);
    expect(restored.historyItemsHasMore).toBe(true);
    expect(restored.historyBeforeItemId).toBe(restored.items[0]!.item!.itemId);
    expect(restored.items).toEqual(snapshot.items.slice(-restored.items.length));
    expect(restored.cursor).toBe(snapshot.cursor);
    const required = new Set<string>();

    for (const entry of restored.items) {
      const content = entry.item?.content;

      if (content?.case !== "userMessage") continue;
      required.add(content.value.clientId);
      const steer = restored.steers.find((candidate) => candidate.id === content.value.clientId);

      expect(steer).toEqual(snapshot.steers.find((candidate) => candidate.id === content.value.clientId));
      expect(steer?.sender?.threadId).toBe(childId);
    }

    expect(required.size).toBeGreaterThan(0);
    const itemBytes = restored.items.reduce((bytes, entry) => bytes + toBinary(ui.TimelineItemSchema, entry).length, 0);

    const steerBytes = restored.steers
      .filter((steer) => required.has(steer.id))
      .reduce((bytes, steer) => bytes + toBinary(ui.SteerSchema, steer).length, 0);

    expect(itemBytes + steerBytes).toBeLessThanOrEqual(384 * 1024);
  });

  test("fork pages and persisted tails keep the inherited steer's original sender", async () => {
    const fork = (await gateway.api.createThread({ forkThreadId: parentId, forkAtTurnId: parentTurnId })).thread!;
    await assertPaging(fork.id, true);
  });
});
