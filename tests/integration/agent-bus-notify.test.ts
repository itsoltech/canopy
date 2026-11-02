import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AgentToolCallSchema, ItemStatus, Provider, ThreadEventSchema, type AgentToolResult, type ui } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { AgentBusStore, SteerStore } from "@open-agents/gateway/store";
import { GatewayCore } from "@open-agents/gateway/core";
import { startGrpcServer } from "@open-agents/transport";
import { openGatewayLink } from "@open-agents/worker/gateway-link";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, ScriptedWorker, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

const json = (result: AgentToolResult) => {
  expect(result.isError).toBe(false);
  return JSON.parse(result.resultJson);
};

describe.skipIf(!dockerAvailable)("agent bus report delivery", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;
  const query = <A extends object>(text: string, ...params: unknown[]) => gw.runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<A>(text, params as never[]);
  }));
  const turns = (id: string) => query<{ id: string; status: string; trigger: string; hops: number }>("SELECT id, status, trigger, hops FROM turns WHERE thread_id = $1::uuid ORDER BY ordinal", id);
  const notification = async (id: string) => (await query<{ notify_status: string; target_turn_id: string; notified_turn_id: string | null }>("SELECT notify_status, target_turn_id, notified_turn_id FROM agent_bus_calls WHERE id = $1::uuid", id))[0]!;
  const steers = (id: string) => query<{ id: string; status: string; hops: number }>("SELECT id, status, hops FROM turn_steers WHERE notification_call_id = $1::uuid", id);
  const snapshot = async (id: string) => {
    const updates = await watchUntil(gw.api, id, (u) => u.length > 0);
    return updates[0]!.change.value as ui.ThreadSnapshot;
  };
  const call = (threadId: string, turnId: string, tool: string, args: unknown) => gw.worker.callTool({ threadId, turnId, tool, args });
  const start = async () => {
    gw.worker.holdTurns = true;
    const parent = (await gw.api.createThread({ projectId, workspaceId, title: "Parent", provider: Provider.CODEX, initialMessage: "delegate" })).thread!;
    const [turn] = await eventually(() => turns(parent.id), (rows) => rows[0]?.status === "running");
    const callId = Bun.randomUUIDv7();
    const child = json(await gw.worker.callTool({ callId, threadId: parent.id, turnId: turn!.id, tool: "spawn_thread", args: { title: "Child", prompt: "read file", notify: true } })) as { thread_id: string; turn_id: string };
    await eventually(() => turns(child.thread_id), (rows) => rows[0]?.status === "running");
    return { parentId: parent.id, parentTurn: turn!.id, childId: child.thread_id, childTurn: child.turn_id, callId };
  };
  const finishParent = async (pair: Awaited<ReturnType<typeof start>>) => {
    gw.worker.holdTurns = false;
    gw.worker.finish(pair.parentId, pair.parentTurn);
    await eventually(() => turns(pair.parentId), (rows) => rows.every((r) => r.status === "completed" || r.status === "cancelled"));
  };

  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Notifications" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/notifications" })).workspace!.id;
    await eventually(() => gw.api.getOverview({}), (o) => o.workers[0]?.appliedVersion === 2n);
  }, 60_000);
  afterAll(async () => { await gw?.close(); });

  test("spawn notify → ask_user → wait_threads → close → parent end: no extra turn", async () => {
    const pair = await start();
    // The provider took the input but has not yet admitted it to the transcript, as while awaiting tools.
    gw.worker.handlers.set("steerTurn", (_value, reply) => reply(true));
    try {
      json(await call(pair.parentId, pair.parentTurn, "ask_user", { wait: false, questions: [{ id: "confirm", header: "Test", question: "Continue?", kind: "text" }] }));
      gw.worker.finish(pair.childId, pair.childTurn, "File contents: hello");
      await eventually(() => steers(pair.callId), (rows) => rows[0]?.status === "accepted");
      const waited = json(await call(pair.parentId, pair.parentTurn, "wait_threads", { thread_ids: [pair.childId], timeout_seconds: 5 }));
      expect(waited).toMatchObject({ done: true, threads: [expect.objectContaining({ last_turn: { turn_id: pair.childTurn, status: "completed" }, last_message: "File contents: hello" })] });
      expect((await notification(pair.callId)).notify_status).toBe("consumed_by_wait");
      json(await call(pair.parentId, pair.parentTurn, "close_thread", { thread_id: pair.childId }));
      // A late refusal or turn-end notice cannot resurrect the consumed report.
      const [steer] = await steers(pair.callId);
      expect((await gw.runtime.runPromise(SteerStore.use((s) => s.queue(steer!.id, "turn ended")))).turn).toBeUndefined();
      await finishParent(pair);
      await gw.core.bus.deliverNotifications();
      expect(await turns(pair.parentId)).toHaveLength(1);
      expect((await snapshot(pair.parentId)).turns.filter((t) => t.status === "queued")).toEqual([]);
    } finally { gw.worker.handlers.delete("steerTurn"); }
  });

  test("without wait, the report joins the running turn with its sender and unchanged target/hops", async () => {
    const pair = await start();
    gw.worker.finish(pair.childId, pair.childTurn, "answer from child");
    const [steer] = await eventually(() => steers(pair.callId), (rows) => rows[0]?.status === "delivered");
    expect(steer?.hops).toBe(2);
    expect(gw.worker.started.get(steer!.id)?.authorAgentId).toBe(pair.childId);
    const view = await snapshot(pair.parentId);
    expect(view.steers[0]).toMatchObject({ sourceThreadId: pair.childId, sender: { title: "Child", provider: Provider.CODEX }, text: "answer from child" });
    expect((await notification(pair.callId))).toMatchObject({ notify_status: "delivered", target_turn_id: pair.childTurn, notified_turn_id: null });
    await finishParent(pair);
    await gw.core.sweep();
    expect(await turns(pair.parentId)).toHaveLength(1);
    expect(await steers(pair.callId)).toHaveLength(1);
  });

  test("an idle caller gets exactly one agent_bus report turn", async () => {
    const pair = await start();
    await finishParent(pair);
    gw.worker.finish(pair.childId, pair.childTurn, "idle result");
    const all = await eventually(() => turns(pair.parentId), (rows) => rows.length === 2 && rows[1]?.status === "completed");
    expect(all[1]).toMatchObject({ trigger: "agent_bus", hops: 2 });
    expect((await snapshot(pair.parentId)).turns[1]).toMatchObject({ sourceKind: "report", sourceThreadId: pair.childId });
    await gw.core.bus.deliverNotifications();
    expect(await turns(pair.parentId)).toHaveLength(2);
  });

  for (const mode of ["not_running", "drop"] as const) {
    test(`a ${mode} report steer falls back once as agent_bus, never user input`, async () => {
      const pair = await start();
      gw.worker.steerMode = mode;
      try {
        gw.worker.finish(pair.childId, pair.childTurn, "fallback result");
        await eventually(() => steers(pair.callId), (rows) => rows[0]?.status === "queued");
        await finishParent(pair);
        await gw.core.sweep();
        const all = await turns(pair.parentId);
        expect(all.map((t) => t.trigger)).toEqual(["user", "agent_bus"]);
        expect(all[1]?.hops).toBe(2);
        expect((await notification(pair.callId)).target_turn_id).toBe(pair.childTurn);
      } finally { gw.worker.steerMode = "accept"; }
    });
  }

  for (const tool of ["get_thread", "read_thread", "list_threads", "interrupt_thread", "close_thread"] as const) {
    test(`${tool}: only an explicit finished result read or stop consumes an outstanding report`, async () => {
      const pair = await start();
      gw.worker.handlers.set("steerTurn", (_value, reply) => reply(true));
      try {
        gw.worker.finish(pair.childId, pair.childTurn, "final result");
        await eventually(() => steers(pair.callId), (rows) => rows[0]?.status === "accepted");
        json(await call(pair.parentId, pair.parentTurn, tool, tool === "list_threads" ? {} : { thread_id: pair.childId }));
        const expected = tool === "list_threads" ? "steering" : ["close_thread", "interrupt_thread"].includes(tool) ? "superseded" : "consumed_by_read";
        expect((await notification(pair.callId)).notify_status).toBe(expected);
        if (tool === "list_threads") await call(pair.parentId, pair.parentTurn, "close_thread", { thread_id: pair.childId });
        await finishParent(pair);
        await gw.core.sweep();
        expect(await turns(pair.parentId)).toHaveLength(1);
      } finally { gw.worker.handlers.delete("steerTurn"); }
    });
  }

  test("read_thread does not consume pages missing the final result; an in-progress read does not consume", async () => {
    const pair = await start();
    json(await call(pair.parentId, pair.parentTurn, "get_thread", { thread_id: pair.childId }));
    expect((await notification(pair.callId)).notify_status).toBe("pending");
    gw.worker.emit(pair.childId, pair.childTurn, { case: "itemCompleted", value: { item: { itemId: "early", status: ItemStatus.COMPLETED, content: { case: "agentMessage", value: { text: "working" } } } } });
    gw.worker.handlers.set("steerTurn", (_value, reply) => reply(true));
    try {
      gw.worker.finish(pair.childId, pair.childTurn, "final result");
      await eventually(() => steers(pair.callId), (rows) => rows[0]?.status === "accepted");
      const page = json(await call(pair.parentId, pair.parentTurn, "read_thread", { thread_id: pair.childId, limit: 1 }));
      expect(page.entries).toHaveLength(1);
      expect((await notification(pair.callId)).notify_status).toBe("steering");
      json(await call(pair.parentId, pair.parentTurn, "read_thread", { thread_id: pair.childId, after_seq: page.nextSeq, limit: 50, view: "items" }));
      expect((await notification(pair.callId)).notify_status).toBe("consumed_by_read");
      await finishParent(pair);
    } finally { gw.worker.handlers.delete("steerTurn"); }
  });

  test("a queued fallback is withdrawn when wait_threads obtains the result before parent end", async () => {
    const pair = await start();
    gw.worker.steerMode = "not_running";
    try {
      gw.worker.finish(pair.childId, pair.childTurn, "already read");
      await eventually(() => steers(pair.callId), (rows) => rows[0]?.status === "queued");
      json(await call(pair.parentId, pair.parentTurn, "wait_threads", { thread_ids: [pair.childId] }));
      expect((await notification(pair.callId)).notify_status).toBe("consumed_by_wait");
      await finishParent(pair);
      expect((await turns(pair.parentId)).map((t) => t.status)).toEqual(["completed", "cancelled"]);
    } finally { gw.worker.steerMode = "accept"; }
  });

  test("an interrupt before the child's result supersedes the future notification", async () => {
    const pair = await start();
    json(await call(pair.parentId, pair.parentTurn, "interrupt_thread", { thread_id: pair.childId }));
    expect((await notification(pair.callId)).notify_status).toBe("superseded");
    gw.worker.finish(pair.childId, pair.childTurn, "late result");
    await eventually(() => turns(pair.childId), (rows) => rows[0]?.status === "completed");
    await finishParent(pair);
    await gw.core.bus.deliverNotifications();
    expect(await turns(pair.parentId)).toHaveLength(1);
    expect(await steers(pair.callId)).toHaveLength(0);
  });

  test("summary consumption and reports refer to the exact target turn, never newer output", async () => {
    const pair = await start();
    const paused = spyOn(gw.core.bus, "onTurnFinished").mockImplementation(async () => {});
    try {
      gw.worker.finish(pair.childId, pair.childTurn, "first result");
      await eventually(() => turns(pair.childId), (rows) => rows[0]?.status === "completed");
      const next = json(await call(pair.parentId, pair.parentTurn, "send_message", { thread_id: pair.childId, prompt: "another task", notify: false }));
      await eventually(() => turns(pair.childId), (rows) => rows[1]?.status === "running");
      gw.worker.finish(pair.childId, next.turn_id, "newer result");
      await eventually(() => turns(pair.childId), (rows) => rows[1]?.status === "completed");
      const summary = json(await call(pair.parentId, pair.parentTurn, "get_thread", { thread_id: pair.childId }));
      expect(summary).toMatchObject({ last_turn: { turn_id: next.turn_id }, last_message: "newer result" });
      expect((await notification(pair.callId)).notify_status).toBe("pending");
    } finally { paused.mockRestore(); }
    await gw.core.bus.deliverNotifications();
    const [steer] = await eventually(() => steers(pair.callId), (rows) => rows[0]?.status === "delivered");
    expect(gw.worker.started.get(steer!.id)?.text).toContain("first result");
    expect(gw.worker.started.get(steer!.id)?.text).not.toContain("newer result");
    await finishParent(pair);
  });

  test("gateway restart before delivery and after steer admission: durable outbox, at most one report", async () => {
    const consumed = await start();
    const refused = await start();
    gw.worker.handlers.set("steerTurn", (_value, reply) => reply(true));
    gw.worker.finish(consumed.childId, consumed.childTurn, "already observed");
    gw.worker.finish(refused.childId, refused.childTurn, "refused at crash");
    await eventually(() => steers(consumed.callId), (rows) => rows[0]?.status === "accepted");
    const [refusedSteer] = await eventually(() => steers(refused.callId), (rows) => rows[0]?.status === "accepted");
    json(await call(consumed.parentId, consumed.parentTurn, "wait_threads", { thread_ids: [consumed.childId] }));
    // Crash boundary: refusal committed to the outbox but its fallback callback did not run.
    await query("UPDATE worker_commands SET status = 'failed' WHERE id = $1::uuid", refusedSteer!.id);
    gw.worker.handlers.delete("steerTurn");
    const pair = await start();
    // Crash boundary: the child's result committed, but its notification callback never ran.
    const paused = spyOn(gw.core.bus, "onTurnFinished").mockImplementation(async () => {});
    gw.worker.finish(pair.childId, pair.childTurn, "restart result");
    await eventually(() => turns(pair.childId), (rows) => rows[0]?.status === "completed");
    expect((await notification(pair.callId)).notify_status).toBe("pending");
    paused.mockRestore();
    gw.worker.link.close();
    await eventually(async () => gw.core.online.has(gw.workerId), (online) => !online);
    // New gateway runtime object and gRPC server over the same persistent database; no original bus state.
    const fresh = new GatewayCore({ runtime: gw.runtime, instanceId: "restart-notify", userId: gw.userId });
    const server = await startGrpcServer({ routes: (router) => fresh.link.routes(router) });
    let worker: ScriptedWorker | undefined;
    try {
      // Crash boundary: steer + command committed, not yet dispatched to a connected worker.
      await fresh.sweep();
      expect((await notification(consumed.callId)).notify_status).toBe("consumed_by_wait");
      expect(await turns(consumed.parentId)).toHaveLength(1);
      expect((await turns(refused.parentId)).map((t) => t.trigger)).toEqual(["user", "agent_bus"]);
      // A wait after recovery still cancels that queued fallback atomically.
      json(await fresh.bus.handle(create(AgentToolCallSchema, {
        callId: Bun.randomUUIDv7(), threadId: refused.parentId, turnId: refused.parentTurn,
        toolName: "wait_threads", argumentsJson: JSON.stringify({ thread_ids: [refused.childId] }),
      })));
      expect((await turns(refused.parentId)).map((t) => t.status)).toEqual(["running", "cancelled"]);
      const [steer] = await steers(pair.callId);
      expect(steer?.status).toBe("pending");
      expect(await query("SELECT id FROM worker_commands WHERE id = $1::uuid AND status = 'pending'", steer!.id)).toHaveLength(1);
      worker = new ScriptedWorker(await openGatewayLink({ baseUrl: server.url, credential: gw.workerCredential, hello: { workerId: gw.workerId, journalId: `journal-${gw.workerId.slice(-6)}` } }));
      const current = worker;
      worker.handlers.set("steerTurn", (value, reply) => {
        const input = value as { inputId: string; input: { text: string } };
        reply(true);
        current.link.send({ case: "threadEvent", value: create(ThreadEventSchema, {
          eventId: Bun.randomUUIDv7(), threadId: pair.parentId, turnId: pair.parentTurn, journalSeq: 10_000n,
          body: { case: "itemCompleted", value: { item: { itemId: `report-${input.inputId}`, status: ItemStatus.COMPLETED,
            content: { case: "userMessage", value: { clientId: input.inputId, text: input.input.text } } } } },
        }) });
      });
      await eventually(() => notification(pair.callId), (row) => row.notify_status === "delivered");
      expect((await notification(pair.callId)).notify_status).toBe("delivered");
      const again = new GatewayCore({ runtime: gw.runtime, instanceId: "restart-again", userId: gw.userId });
      await again.sweep();
      await fresh.sweep();
      expect(await steers(pair.callId)).toHaveLength(1);
      expect(await turns(pair.parentId)).toHaveLength(1);
      expect(worker.commands.filter((command) => command.case === "steerTurn")).toHaveLength(1);
    } finally {
      worker?.link.close();
      await fresh.link.shutdown();
      await server.close();
    }
  });
});
