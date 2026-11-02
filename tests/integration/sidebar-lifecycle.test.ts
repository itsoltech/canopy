import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { PermissionMode, Provider, TurnOutcome } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { GatewayStore } from "@open-agents/gateway/store";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("sidebar settings and thread lifecycle", () => {
  let gw: TestGateway;
  let projectId = "";
  let workspaceId = "";
  const createThread = async (title: string, parentThreadId = "") => {
    const thread = (await gw.api.createThread({ projectId, workspaceId, title, parentThreadId, provider: Provider.CODEX, permissionMode: PermissionMode.ASK })).thread!;
    await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle");
    return thread;
  };
  const turns = (threadId: string) => gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(threadId)));

  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Sidebar" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/sidebar" })).workspace!.id;
    await eventually(() => gw.api.getOverview({}), (o) => o.workers.every((w) => w.appliedVersion > 0n));
    // The scripted worker acknowledges and reports interruption just like the real worker.
    gw.worker.handlers.set("interruptTurn", (value, reply) => {
      const { threadId, turnId } = value as { threadId: string; turnId: string };
      reply(true);
      gw.worker.emit(threadId, turnId, { case: "turnFinished", value: { outcome: TurnOutcome.INTERRUPTED } });
    });
  }, 60_000);
  afterAll(async () => { await gw?.close(); }, 30_000);

  test("pins and project selection persist, respect version conflicts and keep other settings", async () => {
    const t = await createThread("Pinned");
    const before = (await gw.api.getSettings({})).user!;
    const saved = (await gw.api.updateUserSettings({ expectedVersion: before.version, sidebar: { projectIds: [projectId], pinnedThreadIds: [t.id], archived: true } })).settings!;
    expect((await gw.api.getSettings({})).user?.sidebar).toEqual(saved.sidebar);
    expect(saved.appearance).toEqual(before.appearance);
    expect(await failure(gw.api.updateUserSettings({ expectedVersion: before.version, sidebar: {} }))).toContain("changed elsewhere");
    expect(await failure(gw.api.updateUserSettings({ expectedVersion: saved.version, sidebar: { projectIds: ["bad-id"] } }))).toContain("sidebar");
  });

  test("archive hides from the inbox; archive metadata and explicit read state survive reload", async () => {
    const thread = await createThread("Archive me");
    const archived = (await gw.api.setThreadArchived({ threadId: thread.id, archived: true })).thread!;
    expect(archived.archivedBy).toBe("user");
    expect(archived.archivedAt).toBeDefined();
    expect((await gw.api.listThreads({})).threads.some((t) => t.id === thread.id)).toBe(false);
    expect((await gw.api.listThreads({ includeArchived: true })).threads.find((t) => t.id === thread.id)?.status).toBe("archived");
    expect(await failure(gw.api.sendMessage({ threadId: thread.id, text: "no", clientRequestId: "archived" }))).toContain("archived");
    expect((await gw.api.setThreadRead({ threadId: thread.id, unread: true })).thread?.markedUnread).toBe(true);
    expect((await gw.api.getThread({ threadId: thread.id })).thread?.markedUnread).toBe(true);
    expect((await gw.api.markThreadSeen({ threadId: thread.id, upToSeq: 0n })).thread?.markedUnread).toBe(false);
    const restored = (await gw.api.setThreadArchived({ threadId: thread.id, archived: false })).thread!;
    expect([restored.status, restored.archivedAt, restored.archivedBy]).toEqual(["idle", undefined, ""]);
  });

  test("agent close records the parent; archived side threads stay available to Previous agents", async () => {
    const parent = await createThread("Parent agent");
    const child = await createThread("Previous helper", parent.id);
    const result = await gw.worker.callTool({ threadId: parent.id, tool: "close_thread", args: { thread_id: child.id } });
    expect(result.isError).toBe(false);
    const closed = (await gw.api.getThread({ threadId: child.id })).thread!;
    expect([closed.status, closed.archivedBy, closed.archivedByThreadId, closed.archivedByThreadTitle]).toEqual(["archived", "agent", parent.id, parent.title]);
    expect((await gw.api.listThreads({ includeArchived: true })).threads.some((t) => t.id === child.id)).toBe(true);
    await gw.api.setThreadArchived({ threadId: child.id, archived: false });
    expect((await gw.api.getThread({ threadId: child.id })).thread?.archivedBy).toBe("");
  });

  test("delete interrupts the tree, cancels its work, hides every discovery path, and Undo restores only its batch", async () => {
    const caller = await createThread("Observer");
    const parent = await createThread("Delete unique parent");
    const child = await createThread("Delete unique helper", parent.id);
    const earlier = await createThread("Already deleted helper", parent.id);
    await gw.api.deleteThread({ threadId: earlier.id });
    const archivedChild = await createThread("Archived helper", parent.id);
    await gw.api.setThreadArchived({ threadId: archivedChild.id, archived: true });
    const schedule = (await gw.api.createSchedule({ threadId: parent.id, prompt: "later", when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 3600000)) } })).schedule!;
    gw.worker.holdTurns = true;
    for (const t of [parent, child]) {
      await gw.api.sendMessage({ threadId: t.id, text: "hold", clientRequestId: "running" });
      expect((await eventually(() => turns(t.id), (rows) => rows[0]?.status === "running"))[0]?.status).toBe("running");
      await gw.api.sendMessage({ threadId: t.id, text: "queued", clientRequestId: "queued" });
    }
    const deleted = await gw.api.deleteThread({ threadId: parent.id });
    expect(new Set(deleted.threadIds)).toEqual(new Set([parent.id, child.id, archivedChild.id]));
    for (const t of [parent, child]) {
      const ended = await eventually(() => turns(t.id), (rows) => rows[0]?.status === "interrupted");
      expect(ended.map((u) => u.status)).toEqual(["interrupted", "cancelled"]);
      expect(await failure(gw.api.getThread({ threadId: t.id }))).toContain("not found");
      expect(await failure(gw.api.sendMessage({ threadId: t.id, text: "hidden", clientRequestId: "no" }))).toContain("not found");
    }
    expect((await gw.api.listThreads({ projectId, includeArchived: true })).threads.some((t) => deleted.threadIds.includes(t.id))).toBe(false);
    expect((await gw.api.searchThreads({ query: "Delete unique" })).threads).toEqual([]);
    const listed = await gw.worker.callTool({ threadId: caller.id, tool: "list_threads", args: { scope: "all", query: "Delete unique" } });
    expect(listed.isError).toBe(false);
    expect(JSON.parse(listed.content).threads).toEqual([]);
    expect(await failure(gw.api.restoreThread({ threadId: child.id }))).toContain("parent");
    const restored = await gw.api.restoreThread({ threadId: parent.id });
    expect(new Set(restored.threads.map((t) => t.id))).toEqual(new Set(deleted.threadIds));
    expect(restored.threads.find((t) => t.id === archivedChild.id)?.status).toBe("archived");
    expect(await failure(gw.api.getThread({ threadId: earlier.id }))).toContain("not found");
    expect((await gw.api.listSchedules({ threadId: parent.id, includeFinished: true })).schedules.find((s) => s.id === schedule.id)?.status).toBe("cancelled");
    expect((await turns(parent.id)).map((u) => u.status)).toEqual(["interrupted", "cancelled"]);
    gw.worker.holdTurns = false;
  }, 30_000);
});
