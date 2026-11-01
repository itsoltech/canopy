/**
 * Agent bus end to end on PostgreSQL (docs/agent-bus.md): the scripted worker calls bus tools the way
 * Codex does (AgentToolCall), the gateway authorizes and runs them, side threads run on the worker,
 * and results come back to the calling thread as notification turns.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InteractionKind, PermissionMode, Provider, type AgentToolResult } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { eventually, failure, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let mainId = "";

const json = (result: AgentToolResult) => JSON.parse(result.content) as Record<string, unknown>;
const query = <A extends object>(text: string, ...params: unknown[]) =>
  gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<A>(text, params as never[]);
    }),
  );
const turns = (threadId: string) =>
  query<{ ordinal: number; status: string; trigger: string; hops: number; text: string }>(
    "SELECT ordinal, status, trigger, hops, input->>'text' AS text FROM turns WHERE thread_id = $1::uuid ORDER BY ordinal",
    threadId,
  );

describe.skipIf(!dockerAvailable)("agent bus (gateway + scripted worker)", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    const projectId = (await gw.api.createProject({ name: "Bus" })).project!.id;
    const workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/app", label: "" })).workspace!.id;
    const main = (await gw.api.createThread({ projectId, workspaceId, title: "Orchestrator", provider: Provider.CODEX, permissionMode: PermissionMode.ASK, initialMessage: "plan" }))
      .thread!;
    mainId = main.id;
    await eventually(() => turns(mainId), (t) => t[0]?.status === "completed");
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("Codex threads get the bus tools; the main thread is level 0", () => {
    expect(gw.worker.created.find((c) => c.threadId === mainId)).toMatchObject({ enableAgentBus: true, depth: 0 });
  });

  test("spawn_thread: a side thread runs in the same place and its result comes back as a turn of the caller", async () => {
    const spawned = await gw.worker.callTool({ threadId: mainId, tool: "spawn_thread", args: { title: "Reviewer", prompt: "Review the diff" } });
    expect(spawned.isError).toBe(false);
    const { thread_id: sideId } = json(spawned) as { thread_id: string };

    const side = (await gw.api.listThreads({ projectId: (await gw.api.getOverview({})).projects[0]!.id })).threads.find((t) => t.id === sideId)!;
    expect([side.kind, side.parentThreadId, side.spawnedByAgent, side.cwd]).toEqual([2, mainId, true, "/repo/app"]);
    expect(gw.worker.created.find((c) => c.threadId === sideId)).toMatchObject({ depth: 1, enableAgentBus: true });

    // The side thread ran its task...
    const sideTurns = await eventually(() => turns(sideId), (t) => t[0]?.status === "completed");
    expect(sideTurns[0]).toMatchObject({ trigger: "agent_bus", hops: 1 });
    expect(sideTurns[0]?.text).toContain("Review the diff");
    // ...and the orchestrator got a notification turn with the side thread's last message, and ran it.
    const mainTurns = await eventually(() => turns(mainId), (t) => t.length === 2 && t[1]?.status === "completed");
    expect(mainTurns[1]).toMatchObject({ trigger: "agent_bus", hops: 2 });
    expect(mainTurns[1]?.text).toContain(`"Reviewer" (thread_id: ${sideId}) finished a turn: completed`);
    expect(mainTurns[1]?.text).toContain("Echo: [open-agents] Task from");
  });

  test("a re-sent call (same call_id) returns the stored result and starts nothing new", async () => {
    const callId = Bun.randomUUIDv7();
    const first = await gw.worker.callTool({ threadId: mainId, tool: "spawn_thread", args: { title: "Once", prompt: "x", notify: false }, callId });
    const again = await gw.worker.callTool({ threadId: mainId, tool: "spawn_thread", args: { title: "Once", prompt: "x", notify: false }, callId });
    expect(json(again)).toEqual(json(first)); // jsonb may reorder keys
    const rows = await query<{ n: number }>("SELECT count(*)::int AS n FROM threads WHERE title = 'Once'");
    expect(rows[0]?.n).toBe(1);
  });

  test("side threads cannot spawn; invalid calls are tool errors, not crashes", async () => {
    const sideId = (await query<{ id: string }>("SELECT id FROM threads WHERE title = 'Reviewer'"))[0]!.id;
    const nested = await gw.worker.callTool({ threadId: sideId, tool: "spawn_thread", args: { title: "x", prompt: "y" } });
    expect([nested.isError, nested.content]).toEqual([true, "spawn_thread is not available in side threads; ask your parent thread with send_message"]);
    // Refusals are stored too (audit, idempotency), without hops: they started nothing.
    const refused = await query<{ status: string; hops: number | null }>(
      "SELECT status, hops FROM agent_bus_calls WHERE source_thread_id = $1::uuid AND tool = 'spawn_thread'",
      sideId,
    );
    expect(refused).toEqual([{ status: "failed", hops: null }]);
    const unknown = await gw.worker.callTool({ threadId: mainId, tool: "rm_rf", args: {} });
    expect(unknown.content).toContain('unknown agent bus tool "rm_rf"');
    const excess = await gw.worker.callTool({ threadId: mainId, tool: "get_thread", args: { thread_id: sideId, extra: 1 } });
    expect(excess.isError).toBe(true);
    const foreign = await gw.worker.callTool({ threadId: mainId, tool: "get_thread", args: { thread_id: Bun.randomUUIDv7() } });
    expect(foreign.content).toContain("not found in your thread tree");
    const goal = await gw.worker.callTool({ threadId: mainId, tool: "propose_goal", args: { objective: "x", condition: "y" } });
    expect(goal.content).toBe("propose_goal is not available in this thread");
  });

  test("reading the tree: list_threads, get_thread, read_thread, wait_threads", async () => {
    const sideId = (await query<{ id: string }>("SELECT id FROM threads WHERE title = 'Reviewer'"))[0]!.id;
    const listed = json(await gw.worker.callTool({ threadId: mainId, tool: "list_threads", args: {} })) as { threads: { title: string }[] };
    expect(listed.threads.map((t) => t.title).sort()).toEqual(["Once", "Reviewer"]);
    const status = json(await gw.worker.callTool({ threadId: mainId, tool: "get_thread", args: { thread_id: sideId } }));
    expect(status).toMatchObject({ thread_id: sideId, kind: "side", settled: true, status: "idle" });
    expect(String(status["last_message"])).toStartWith("Echo: [open-agents] Task from");
    const read = json(await gw.worker.callTool({ threadId: mainId, tool: "read_thread", args: { thread_id: sideId } })) as { entries: { type: string }[] };
    expect(read.entries.map((e) => e.type)).toContain("agent_message");
    const waited = json(await gw.worker.callTool({ threadId: mainId, tool: "wait_threads", args: { thread_ids: [sideId], timeout_seconds: 5 } }));
    expect(waited["done"]).toBe(true);
    // Siblings may talk; the side thread sees the tree but not beyond it.
    const fromSide = json(await gw.worker.callTool({ threadId: sideId, tool: "list_threads", args: { scope: "tree" } })) as { threads: { title: string }[] };
    expect(fromSide.threads.map((t) => t.title).sort()).toEqual(["Once", "Orchestrator"]);
  });

  test("send_message: a follow-up runs as the next turn of the target and notifies the sender", async () => {
    const sideId = (await query<{ id: string }>("SELECT id FROM threads WHERE title = 'Reviewer'"))[0]!.id;
    const before = (await turns(mainId)).length;
    const sent = await gw.worker.callTool({ threadId: mainId, tool: "send_message", args: { thread_id: sideId, prompt: "Also check tests" } });
    expect(sent.isError).toBe(false);
    const sideTurns = await eventually(() => turns(sideId), (t) => t.length === 2 && t[1]?.status === "completed");
    expect(sideTurns[1]?.text).toContain('Message from the thread "Orchestrator"');
    const mainTurns = await eventually(() => turns(mainId), (t) => t.length === before + 1 && t[before]?.status === "completed");
    expect(mainTurns[before]?.text).toContain("finished a turn: completed");
  });

  test("a side thread's permission prompt goes to the parent agent, which answers it", async () => {
    const sideId = (await query<{ id: string }>("SELECT id FROM threads WHERE title = 'Reviewer'"))[0]!.id;
    const requestId = Bun.randomUUIDv7();
    gw.worker.ask({ requestId, threadId: sideId, kind: InteractionKind.PERMISSION, toolName: "shell", requestJson: '{"command":"bun test"}' });
    // The parent is woken with the question (trigger = interaction)...
    const forwarded = await eventually(
      () => query<{ text: string; hops: number }>("SELECT input->>'text' AS text, hops FROM turns WHERE interaction_request_id = $1::uuid", requestId),
      (rows) => rows.length === 1,
    );
    expect(forwarded[0]?.text).toContain(`request_id: ${requestId}`);
    // ...and answers through the bus; the worker gets the decision.
    const answered = await gw.worker.callTool({ threadId: mainId, tool: "answer_interaction", args: { request_id: requestId, response: "allow" } });
    expect(json(answered)).toEqual({ request_id: requestId, status: "allowed" });
    await eventually(async () => gw.worker.interactionAnswers, (a) => a.some((x) => x.requestId === requestId));
    expect(gw.worker.interactionAnswers.find((x) => x.requestId === requestId)?.allow).toBe(true);
    const row = await query<{ answered_by_thread_id: string; answered_by: string | null }>(
      "SELECT answered_by_thread_id, answered_by FROM interaction_requests WHERE id = $1::uuid",
      requestId,
    );
    expect(row[0]).toEqual({ answered_by_thread_id: mainId, answered_by: null });
  });

  test("a user-created side thread keeps its questions for the user", async () => {
    const projectId = (await gw.api.getOverview({})).projects[0]!.id;
    const workspaceId = (await gw.api.getOverview({})).projects[0]!.workspaces[0]!.id;
    const side = (await gw.api.createThread({ projectId, workspaceId, parentThreadId: mainId, title: "Mine", provider: Provider.CODEX })).thread!;
    await eventually(() => query<{ status: string }>("SELECT status FROM threads WHERE id = $1::uuid", side.id), (r) => r[0]?.status === "idle");
    const requestId = Bun.randomUUIDv7();
    gw.worker.ask({ requestId, threadId: side.id, kind: InteractionKind.PERMISSION, toolName: "shell", requestJson: "{}" });
    const rows = await eventually(
      () => query<{ routed_to: string }>("SELECT routed_to FROM interaction_requests WHERE id = $1::uuid", requestId),
      (r) => r.length === 1,
    );
    expect(rows[0]?.routed_to).toBe("human");
    const answer = await gw.worker.callTool({ threadId: mainId, tool: "answer_interaction", args: { request_id: requestId, response: "allow" } });
    expect(answer.content).toBe("this interaction is answered by the user");
  });

  test("schedules: a wake-up fires once as a schedule turn; a recurring one runs until max_runs; limits apply", async () => {
    const sideId = (await query<{ id: string }>("SELECT id FROM threads WHERE title = 'Reviewer'"))[0]!.id;
    const wakeup = json(await gw.worker.callTool({ threadId: mainId, tool: "schedule_wakeup", args: { prompt: "Check CI", delay_seconds: 600 } }));
    expect(wakeup).toMatchObject({ thread_id: mainId });
    // For a child too, but only orchestrators control others' schedules.
    const recurring = json(
      await gw.worker.callTool({ threadId: mainId, tool: "schedule_recurring", args: { prompt: "Status?", cron: "*/30 * * * *", max_runs: 2, thread_id: sideId } }),
    );
    expect(recurring).toMatchObject({ thread_id: sideId, cron: "*/30 * * * *", timezone: "UTC" });
    expect((await gw.worker.callTool({ threadId: mainId, tool: "schedule_recurring", args: { prompt: "x", cron: "0,1,2 * * * *", max_runs: 3 } })).content).toBe(
      "cron runs more often than every 5 minutes",
    );
    expect((await gw.worker.callTool({ threadId: mainId, tool: "schedule_recurring", args: { prompt: "x", cron: "0 * * * *" } })).content).toBe(
      "set until or max_runs",
    );
    const listed = json(await gw.worker.callTool({ threadId: mainId, tool: "list_schedules", args: {} })) as { schedules: { schedule_id: string }[] };
    expect(listed.schedules.map((s) => s.schedule_id).sort()).toEqual([String(wakeup["schedule_id"]), String(recurring["schedule_id"])].sort());

    // Nothing is due now; in 11 minutes the wake-up is, and the recurring schedule too (every 30 min).
    expect(await gw.core.scheduler.tick(new Date())).toBe(0);
    const mainBefore = (await turns(mainId)).length;
    expect(await gw.core.scheduler.tick(new Date(Date.now() + 31 * 60_000))).toBe(2);
    const mainTurns = await eventually(() => turns(mainId), (t) => t.length === mainBefore + 1 && t[mainBefore]?.status === "completed");
    expect(mainTurns[mainBefore]).toMatchObject({ trigger: "schedule", hops: 1 });
    expect(mainTurns[mainBefore]?.text).toContain("Scheduled wake-up");
    expect(mainTurns[mainBefore]?.text).toContain("Check CI");
    const states = await query<{ id: string; status: string; runs: number }>("SELECT id, status, runs FROM schedules ORDER BY created_at");
    expect(states.map((s) => [s.status, s.runs])).toEqual([
      ["completed", 1],
      ["active", 1],
    ]);
    // The second run completes the recurring schedule (max_runs = 2).
    expect(await gw.core.scheduler.tick(new Date(Date.now() + 3 * 3600_000))).toBe(1);
    const after = await query<{ status: string; runs: number }>("SELECT status, runs FROM schedules WHERE id = $1::uuid", recurring["schedule_id"]);
    expect(after[0]).toEqual({ status: "completed", runs: 2 });
    const sideTurns = await eventually(() => turns(sideId), (t) => t.filter((x) => x.trigger === "schedule" && x.status === "completed").length === 2);
    expect(sideTurns.filter((x) => x.trigger === "schedule")[1]?.text).toContain("run 2 of 2");
  });

  test("cancel_schedule; a side thread cannot schedule its parent", async () => {
    const sideId = (await query<{ id: string }>("SELECT id FROM threads WHERE title = 'Reviewer'"))[0]!.id;
    const created = json(await gw.worker.callTool({ threadId: sideId, tool: "schedule_wakeup", args: { prompt: "later", delay_seconds: 3600 } }));
    const notMine = await gw.worker.callTool({ threadId: sideId, tool: "schedule_wakeup", args: { prompt: "x", delay_seconds: 3600, thread_id: mainId } });
    expect(notMine.content).toBe("you can only control threads you spawned");
    // The parent may cancel its child's schedule.
    expect(json(await gw.worker.callTool({ threadId: mainId, tool: "cancel_schedule", args: { schedule_id: created["schedule_id"] } }))).toEqual({
      schedule_id: created["schedule_id"],
      cancelled: true,
    });
    expect(await gw.core.scheduler.tick(new Date(Date.now() + 2 * 3600_000))).toBe(0);
  });

  test("close_thread archives the side thread; it no longer counts or receives messages", async () => {
    const onceId = (await query<{ id: string }>("SELECT id FROM threads WHERE title = 'Once'"))[0]!.id;
    const closed = await gw.worker.callTool({ threadId: mainId, tool: "close_thread", args: { thread_id: onceId } });
    expect(json(closed)).toEqual({ thread_id: onceId, closed: true });
    const send = await gw.worker.callTool({ threadId: mainId, tool: "send_message", args: { thread_id: onceId, prompt: "x" } });
    expect(send.content).toBe("target thread is archived");
    const listed = json(await gw.worker.callTool({ threadId: mainId, tool: "list_threads", args: {} })) as { threads: { title: string }[] };
    expect(listed.threads.map((t) => t.title).sort()).toEqual(["Mine", "Reviewer"]);
  });

  test("schedules in the UI API: create (validated), list with their creator, pause, resume, cancel, live updates", async () => {
    const at = (date: Date) => timestampFromDate(date);
    expect(await failure(gw.api.createSchedule({ threadId: mainId, prompt: "x", when: { case: "cron", value: "*/2 * * * *" } }))).toContain("more often");
    expect(await failure(gw.api.createSchedule({ threadId: mainId, prompt: "x", when: { case: "cron", value: "0 9 * * *" }, timezone: "Mars/Base" }))).toContain("time zone");
    expect(await failure(gw.api.createSchedule({ threadId: mainId, prompt: "x", when: { case: "runAt", value: at(new Date(Date.now() - 3600_000)) } }))).toContain("past");

    // A user's recurring schedule may be open-ended (agents' may not).
    const updates: string[] = [];
    const controller = new AbortController();
    const watching = (async () => {
      for await (const u of gw.api.watchOverview({}, { signal: controller.signal })) if (u.change.case === "schedule") updates.push(u.change.value.status);
    })().catch(() => {});
    await Bun.sleep(50);
    const daily = (await gw.api.createSchedule({ threadId: mainId, prompt: "Daily summary", when: { case: "cron", value: "0 9 * * *" }, timezone: "Europe/Warsaw" })).schedule!;
    expect(daily).toMatchObject({ kind: "recurring", status: "active", createdBy: "user", timezone: "Europe/Warsaw", maxRuns: 0 });
    const preview = await gw.api.previewSchedule({ cron: "0 9 * * *", timezone: "Europe/Warsaw", count: 3 });
    expect(preview.nextRuns.map((t) => timestampDate(t).getUTCHours())).toEqual([8, 8, 8]); // 09:00 Warsaw in winter
    expect(await failure(gw.api.previewSchedule({ cron: "* * * * *" }))).toContain("more often");

    const agentMade = json(await gw.worker.callTool({ threadId: mainId, tool: "schedule_wakeup", args: { prompt: "agent reminder", delay_seconds: 600 } }));
    const listed = (await gw.api.listSchedules({ threadId: mainId })).schedules;
    expect(listed.find((x) => x.id === agentMade["schedule_id"])).toMatchObject({ createdBy: "agent", createdByThreadId: mainId });
    expect(listed.map((x) => x.id)).toContain(daily.id);

    const paused = (await gw.api.setScheduleStatus({ scheduleId: daily.id, status: "paused" })).schedule!;
    expect([paused.status, paused.nextRunAt]).toEqual(["paused", undefined]);
    expect(await gw.core.scheduler.tick(new Date(Date.now() + 2 * 86_400_000))).toBe(1); // only the agent's wake-up
    const resumed = (await gw.api.setScheduleStatus({ scheduleId: daily.id, status: "active" })).schedule!;
    expect(resumed.status).toBe("active");
    expect(resumed.nextRunAt).toBeDefined();

    const snapshot = (await watchUntil(gw.api, mainId, (u) => u.length >= 1))[0];
    expect(snapshot?.change.case === "snapshot" ? snapshot.change.value.schedules.map((x) => x.id) : []).toContain(daily.id);

    await gw.api.setScheduleStatus({ scheduleId: daily.id, status: "cancelled" });
    expect(await failure(gw.api.setScheduleStatus({ scheduleId: daily.id, status: "active" }))).toContain("already cancelled");
    await eventually(async () => updates, (u) => u.includes("cancelled"));
    controller.abort();
    await watching;
    // created, the agent's, paused, resumed, the agent's fired (completed), cancelled
    expect(updates).toEqual(expect.arrayContaining(["active", "paused", "completed", "cancelled"]));
  });

  test("turns carry their source: task, message, report, question, schedule", async () => {
    const snapshotTurns = async (threadId: string) => {
      const first = (await watchUntil(gw.api, threadId, (u) => u.length >= 1))[0];
      return first?.change.case === "snapshot" ? first.change.value.turns : [];
    };
    const sideId = (await query<{ id: string }>("SELECT id FROM threads WHERE title = 'Reviewer'"))[0]!.id;
    const side = await snapshotTurns(sideId);
    expect(side.map((t) => [t.sourceKind, t.sourceThreadId === mainId])).toEqual(
      expect.arrayContaining([
        ["task", true],
        ["message", true],
      ]),
    );
    const task = side.find((t) => t.sourceKind === "task")!;
    expect(task.messageText).toBe("Review the diff");
    expect(task.platformNote).toStartWith('[open-agents] Task from the thread "Orchestrator"');
    expect(task.inputText).toBe(`${task.platformNote}\n\n${task.messageText}`); // what the model got
    const main = await snapshotTurns(mainId);
    const kinds = main.map((t) => t.sourceKind);
    expect(kinds[0]).toBe(""); // the user's first message
    const report = main.find((t) => t.sourceKind === "report")!;
    expect([report.sourceThreadId, report.sourceStatus]).toEqual([sideId, "completed"]);
    expect(report.messageText).toStartWith("Echo: [open-agents] Task from"); // the side thread's last message
    const question = main.find((t) => t.sourceKind === "question")!;
    expect([question.questionKind, question.questionTool, question.messageText]).toEqual(["permission", "shell", ""]);
    expect(question.interactionRequestId).not.toBe("");
    const scheduled = main.find((t) => t.sourceKind === "schedule");
    expect(scheduled?.scheduleId).not.toBe("");
    expect(scheduled?.sourceThreadId).toBe(mainId); // an agent schedule: created by this thread's agent
    expect(scheduled?.messageText).toBe("Check CI");
  });
});
