import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { MentionKind, PermissionMode, Provider, TurnOutcome } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { GatewayStore } from "@open-agents/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
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
    const saved = (await gw.api.updateUserSettings({ expectedVersion: before.version, sidebar: { projectIds: [projectId], pinnedThreadIds: [t.id], archivedExpanded: true } })).settings!;
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
    expect((await gw.api.setThreadArchived({ threadId: thread.id, archived: true })).thread?.archivedAt).toEqual(archived.archivedAt);
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

  test("main archive cascades, interrupts running sides and restores exactly its cascade", async () => {
    const parent = await createThread("Cascade parent");
    const running = await createThread("Running cascade helper", parent.id);
    const userArchived = await createThread("Independently archived helper", parent.id);
    const agentArchived = await createThread("Agent closed helper", parent.id);
    const untouched = await createThread("Unrelated active thread");
    await gw.api.setThreadArchived({ threadId: userArchived.id, archived: true });
    const closed = await gw.worker.callTool({ threadId: parent.id, tool: "close_thread", args: { thread_id: agentArchived.id } });
    expect(closed.isError).toBe(false);
    gw.worker.holdTurns = true;
    await gw.api.sendMessage({ threadId: running.id, text: "hold", clientRequestId: "running" });
    await eventually(() => turns(running.id), (rows) => rows[0]?.status === "running");
    await gw.api.sendMessage({ threadId: running.id, text: "queued", clientRequestId: "queue" });
    const schedule = (await gw.api.createSchedule({ threadId: running.id, prompt: "later", when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 3600000)) } })).schedule!;
    await gw.api.setThreadArchived({ threadId: parent.id, archived: true });
    const cascaded = (await gw.api.getThread({ threadId: running.id })).thread!;
    expect([cascaded.status, cascaded.archivedBy, cascaded.archivedByThreadId]).toEqual(["archived", "cascade", parent.id]);
    expect((await eventually(() => turns(running.id), (rows) => rows[0]?.status === "interrupted")).map((t) => t.status)).toEqual(["interrupted", "cancelled"]);
    expect((await gw.api.listSchedules({ threadId: running.id, includeFinished: true })).schedules.find((s) => s.id === schedule.id)?.status).toBe("cancelled");
    expect((await gw.api.listThreads({ sidebarOnly: true })).threads.some((t) => [parent.id, running.id, userArchived.id, agentArchived.id].includes(t.id))).toBe(false);
    const archive = await gw.api.listArchivedThreads({ query: "Cascade parent" });
    expect(archive.threads.map((t) => t.id)).toEqual([parent.id]);
    expect(new Set(archive.sideThreads.map((t) => t.id))).toEqual(new Set([running.id, userArchived.id, agentArchived.id]));
    expect(await failure(gw.api.setThreadArchived({ threadId: running.id, archived: false }))).toContain("parent thread first");
    expect(await failure(gw.api.createThread({ projectId, workspaceId, parentThreadId: parent.id, provider: Provider.CODEX, title: "Cannot escape the cascade" }))).toContain("archived");
    await gw.api.setThreadArchived({ threadId: parent.id, archived: false });
    expect((await gw.api.getThread({ threadId: running.id })).thread?.status).toBe("idle");
    expect((await gw.api.getThread({ threadId: running.id })).thread?.archivedBy).toBe("");
    expect((await gw.api.getThread({ threadId: userArchived.id })).thread?.archivedBy).toBe("user");
    expect((await gw.api.getThread({ threadId: agentArchived.id })).thread?.archivedBy).toBe("agent");
    expect((await gw.api.getThread({ threadId: untouched.id })).thread?.status).toBe("idle");
    expect(await turns(running.id)).toHaveLength(2); // restore does not replay cancelled work
    // Independent archive after a cascade restore must survive the next parent archive/restore too.
    await gw.api.setThreadArchived({ threadId: running.id, archived: true });
    await gw.api.setThreadArchived({ threadId: parent.id, archived: true });
    await gw.api.setThreadArchived({ threadId: parent.id, archived: false });
    expect((await gw.api.getThread({ threadId: running.id })).thread?.archivedBy).toBe("user");
    gw.worker.holdTurns = false;
  });

  test("archive and delete cancel durable answers and background notes; restoring does not replay them", async () => {
    for (const operation of ["archive", "delete"] as const) {
      const thread = await createThread(`Pending deliveries: ${operation}`);
      gw.worker.holdTurns = true;
      const turn = (await gw.api.sendMessage({ threadId: thread.id, text: "ask", clientRequestId: operation })).turn!;
      await eventually(() => turns(thread.id), (rows) => rows[0]?.status === "running");
      const result = await gw.worker.callTool({ threadId: thread.id, turnId: turn.id, tool: "ask_user", args: {
        questions: [{ id: "next", header: "Next", question: "Continue?", kind: "single_choice", options: [{ label: "Yes" }, { label: "No" }] }], wait: false,
      } });
      expect(result.isError).toBe(false);
      const questionId = (JSON.parse(result.content) as { question_set_id: string }).question_set_id;
      // Crash boundary: a consumed answer has not reached the agent; a background note awaits steer delivery.
      await gw.runtime.runPromise(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const steerId = Bun.randomUUIDv7();
        yield* sql`UPDATE interaction_requests SET status = 'answered', answered_at = now(), answered_by = ${gw.userId}::uuid, answer_delivery = 'consumed'
          WHERE id = ${questionId}::uuid`;
        yield* sql`INSERT INTO turn_steers (id, thread_id, turn_id, input, background_note, hops)
          VALUES (${steerId}::uuid, ${thread.id}::uuid, ${turn.id}::uuid, '{}'::jsonb, true, 1)`;
        yield* sql`INSERT INTO thread_items (thread_id, item_id, type, status, content, first_seq, last_seq)
          VALUES (${thread.id}::uuid, 'bg:pending', 'background_task', 'completed', '{}'::jsonb, 0, 0)`;
        yield* sql`INSERT INTO background_task_notes (thread_id, item_id, status, wake, ended_at, hops, steer_id)
          VALUES (${thread.id}::uuid, 'bg:pending', 'steering', true, now(), 1, ${steerId}::uuid)`;
      }));
      if (operation === "archive") await gw.api.setThreadArchived({ threadId: thread.id, archived: true });
      else await gw.api.deleteThread({ threadId: thread.id });
      await eventually(() => turns(thread.id), (rows) => rows[0]?.status === "interrupted");
      expect(await gw.runtime.runPromise(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          answers: yield* sql`SELECT answer_delivery FROM interaction_requests WHERE id = ${questionId}::uuid`,
          notes: yield* sql`SELECT status, steer_id FROM background_task_notes WHERE thread_id = ${thread.id}::uuid`,
        };
      }))).toEqual({ answers: [{ answer_delivery: "cancelled" }], notes: [{ status: "cancelled", steer_id: null }] });
      if (operation === "archive") await gw.api.setThreadArchived({ threadId: thread.id, archived: false });
      else await gw.api.restoreThread({ threadId: thread.id });
      await gw.core.bus.deliverAnswers();
      await gw.core.backgroundTasks.tick();
      expect(await turns(thread.id)).toHaveLength(1);
      gw.worker.holdTurns = false;
    }
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
    const placeholder = "#Deleted";
    expect(await failure(gw.api.sendMessage({
      threadId: caller.id, text: placeholder, clientRequestId: "stale-mention",
      mentions: [{ kind: MentionKind.THREAD, name: parent.id, label: "Deleted", start: 0, end: placeholder.length }],
    }))).toContain("mentioned thread was not found");
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
