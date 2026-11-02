/**
 * The agent hears about its background tasks (docs/execution.md, "Pobudka"; docs/agent-bus.md, "Zadania w tle"):
 * scripted worker -> background_task end -> Ingest writes the note -> a turn of its own (trigger background_task) or
 * a steer of the running turn; worker restarts (worker_shutdown, re-sent and repeated ends: one note); Claude's own
 * wake-up after a completion (no second turn); the user's stop (no wake-up, joins the next turn); the hop limit;
 * the agent's tools (list_background_tasks, get_background_task, stop_background_task).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { BackgroundTaskKind, ItemStatus, PermissionMode, Provider, ThreadEventSchema, TurnOrigin, TurnOutcome, ui } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { SqlClient } from "effect/sql";
import { Effect } from "effect";
import { eventually, startTestGateway, watchUntil, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";
import { ClaudeEventMapper, startsTurn } from "../../apps/worker/src/providers/claude/mapping.ts";

const GRACE_MS = 1_500;

let gw: TestGateway;

describe.skipIf(!dockerAvailable)("background task notes (gateway)", () => {
  let projectId = "";
  let codexWorkspace = "";
  let claudeWorkspace = "";
  let claudeWorker: ScriptedWorker;
  let studio: { workerId: string; credential: string };

  beforeAll(async () => {
    gw = await startTestGateway({ backgroundGraceMs: GRACE_MS });
    studio = await gw.addWorker("studio", ["/studio"]);
    claudeWorker = await gw.connect(studio.workerId, studio.credential, undefined, { claude: true });
    projectId = (await gw.api.createProject({ name: "Background" })).project!.id;
    codexWorkspace = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/bg" })).workspace!.id;
    claudeWorkspace = (await gw.api.createWorkspace({ projectId, workerId: studio.workerId, rootPath: "/studio/bg" })).workspace!.id;
    await eventually(() => gw.api.getOverview({}), (o) => o.workers.every((w) => w.appliedVersion === 2n));
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  const newThread = async (provider = Provider.CODEX) => {
    const thread = (
      await gw.api.createThread({ projectId, workspaceId: provider === Provider.CLAUDE ? claudeWorkspace : codexWorkspace, title: "bg", provider, permissionMode: PermissionMode.ASK })
    ).thread!;
    await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle");
    return thread.id;
  };
  const snapshot = async (threadId: string) => {
    const updates = await watchUntil(gw.api, threadId, (u) => u.some((x) => x.change.case === "snapshot"));
    return updates.find((u) => u.change.case === "snapshot")!.change.value as ui.ThreadSnapshot;
  };
  const noteTurns = async (threadId: string) => (await snapshot(threadId)).turns.filter((t) => t.trigger === "background_task");
  const task = (itemId: string, taskId: string, turnId: string, extra: Record<string, unknown> = {}) => ({
    itemId,
    status: ItemStatus.IN_PROGRESS,
    content: { case: "backgroundTask" as const, value: { taskId, processId: taskId, kind: BackgroundTaskKind.PROCESS, command: "python3 train.py", startedInTurnId: turnId, ...extra } },
  });
  const ended = (itemId: string, taskId: string, status: ItemStatus, value: Record<string, unknown>) => ({
    itemId,
    status,
    content: { case: "backgroundTask" as const, value: { taskId, processId: taskId, kind: BackgroundTaskKind.PROCESS, command: "python3 train.py", ...value } },
  });

  /** A user turn that leaves a process running in the background (as Codex does); returns the turn id. */
  const startTask = async (worker: ScriptedWorker, threadId: string, itemId: string, taskId: string, output = "epoch 1/3\n") => {
    let turnId = "";
    worker.handlers.set("startTurn", (value, reply) => {
      turnId = (value as { turnId: string }).turnId;
      reply(true);
      worker.emit(threadId, turnId, { case: "turnStarted", value: { origin: TurnOrigin.COMMAND } });
      worker.emit(threadId, turnId, { case: "itemStarted", value: { item: task(itemId, taskId, turnId, { output }) } });
      worker.emit(threadId, turnId, { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } });
    });
    await gw.api.sendMessage({ threadId, text: "train in the background", clientRequestId: `start-${itemId}-${threadId.slice(-6)}` });
    await eventually(() => gw.api.getThread({ threadId }), (r) => r.thread?.backgroundTasks === 1 && r.thread.status === "idle");
    worker.handlers.delete("startTurn");
    return turnId;
  };

  test("Codex: a task that completes after its turn wakes the thread with a note turn (what, how, when, output, tools)", async () => {
    const threadId = await newThread();
    const worker = gw.worker;
    await startTask(worker, threadId, "bg:exec-1", "101");
    worker.emit(threadId, "", { case: "itemCompleted", value: { item: ended("bg:exec-1", "101", ItemStatus.COMPLETED, { exitCode: 0, output: "epoch 1/3\nepoch 3/3\ndone\n" }) } });
    const turns = await eventually(() => noteTurns(threadId), (t) => t.length === 1 && t[0]!.status === "completed");
    expect(turns[0]).toMatchObject({ trigger: "background_task", sourceKind: "background_task", hops: 1, backgroundItemIds: ["bg:exec-1"] });
    const input = worker.started.get(turns[0]!.id)?.text ?? "";
    expect(input).toStartWith("[open-agents] A background task of this thread ended: completed with exit code 0.");
    expect(input).toContain('Task "python3 train.py" (task_id: bg:exec-1)');
    expect(input).toContain("epoch 3/3\ndone");
    expect(input).toContain("get_background_task");
    expect(turns[0]!.platformNote).toBe(input);
    // The item has its times (the gateway stamped the scripted worker's events).
    const item = (await snapshot(threadId)).items.find((i) => i.item?.itemId === "bg:exec-1")?.item;
    expect(item?.content.case === "backgroundTask" && item.content.value.startedAt && item.content.value.endedAt).toBeTruthy();
    // A repeated end (another event) does not make a second note.
    worker.emit(threadId, "", { case: "itemCompleted", value: { item: ended("bg:exec-1", "101", ItemStatus.COMPLETED, { exitCode: 0 }) } });
    await gw.core.backgroundTasks.tick();
    await Bun.sleep(300);
    expect(await noteTurns(threadId)).toHaveLength(1);
  }, 30_000);

  test("a task that ends while a turn runs is steered into it, without a turn of its own", async () => {
    const threadId = await newThread();
    const worker = gw.worker;
    await startTask(worker, threadId, "bg:exec-2", "102");
    worker.holdTurns = true;
    try {
      await gw.api.sendMessage({ threadId, text: "keep working", clientRequestId: "hold-2" });
      const running = await eventually(() => snapshot(threadId), (s) => s.turns.some((t) => t.status === "running"));
      const turnId = running.turns.find((t) => t.status === "running")!.id;
      worker.emit(threadId, "", { case: "itemCompleted", value: { item: ended("bg:exec-2", "102", ItemStatus.FAILED, { exitCode: 2, stopReason: "error", output: "Traceback\nValueError\n" }) } });
      const steer = await eventually(async () => [...worker.steered.values()].find((t) => t.includes("bg:exec-2")), (t) => t !== undefined);
      expect(steer).toStartWith("[open-agents] A background task of this thread ended: failed with exit code 2.");
      const state = await eventually(() => snapshot(threadId), (s) => s.steers.some((x) => x.backgroundItemIds.includes("bg:exec-2") && x.status === "delivered"));
      expect(state.steers.find((x) => x.backgroundItemIds.length > 0)).toMatchObject({ turnId, backgroundItemIds: ["bg:exec-2"], status: "delivered" });
      worker.finish(threadId, turnId);
      await eventually(() => gw.api.getThread({ threadId }), (r) => r.thread?.status === "idle");
      await gw.core.backgroundTasks.tick();
      expect(await noteTurns(threadId)).toHaveLength(0);
    } finally {
      worker.holdTurns = false;
    }
  }, 30_000);

  test("worker restart: worker_shutdown closes the task, re-sent and repeated ends make one note turn", async () => {
    const threadId = await newThread();
    const worker = gw.worker;
    await startTask(worker, threadId, "bg:exec-3", "103");
    // The worker records the shutdown and sends it; the link closes before the gateway answers anything else.
    const shutdown = create(ThreadEventSchema, {
      threadId,
      journalSeq: 1_000n,
      eventId: Bun.randomUUIDv7(),
      occurredAt: timestampFromMs(Date.now()),
      body: { case: "itemCompleted", value: { item: ended("bg:exec-3", "103", ItemStatus.INTERRUPTED, { stopReason: "worker_shutdown", endedAt: timestampFromMs(Date.now()) }) } },
      rawJson: "{}",
    });
    worker.link.send({ case: "threadEvent", value: shutdown });
    await eventually(() => gw.api.getThread({ threadId }), (r) => r.thread?.backgroundTasks === 0);
    // The new process re-sends it (journal not acked yet) and its recovery finds nothing else open... and a stray
    // close of the same task (another event id) does not count twice.
    worker.link.send({ case: "threadEvent", value: shutdown });
    worker.emit(threadId, "", { case: "itemCompleted", value: { item: ended("bg:exec-3", "103", ItemStatus.INTERRUPTED, { stopReason: "worker_lost" }) } });
    const turns = await eventually(() => noteTurns(threadId), (t) => t.length === 1 && t[0]!.status === "completed");
    const input = worker.started.get(turns[0]!.id)?.text ?? "";
    expect(input).toContain("stopped because the worker was shut down for a restart or deploy");
    expect(input).toContain("start it again if it is still needed");
    await gw.core.backgroundTasks.tick();
    await Bun.sleep(300);
    expect(await noteTurns(threadId)).toHaveLength(1);
    // The task reads as stopped by the shutdown.
    const item = (await snapshot(threadId)).items.find((i) => i.item?.itemId === "bg:exec-3")?.item;
    expect(item?.content.case === "backgroundTask" && item.content.value.stopReason).toBe("worker_shutdown");
  }, 30_000);

  test("worker restart: the note turn waits in the outbox while the worker is gone and reaches the new process once", async () => {
    const threadId = await newThread(Provider.CLAUDE);
    await startTask(claudeWorker, threadId, "bg:task-r", "r1");
    // Graceful stop: the runtimes are down (a StartTurn now gets no answer), the end is sent, then the link closes.
    claudeWorker.handlers.set("startTurn", () => {});
    const shutdown = create(ThreadEventSchema, {
      threadId,
      journalSeq: 2_000n,
      eventId: Bun.randomUUIDv7(),
      occurredAt: timestampFromMs(Date.now()),
      body: { case: "itemCompleted", value: { item: ended("bg:task-r", "r1", ItemStatus.INTERRUPTED, { kind: BackgroundTaskKind.SHELL, stopReason: "worker_shutdown" }) } },
      rawJson: "{}",
    });
    claudeWorker.link.send({ case: "threadEvent", value: shutdown });
    await eventually(() => noteTurns(threadId), (t) => t.length === 1);
    claudeWorker.link.close();
    await eventually(async () => gw.core.online.has(studio.workerId), (online) => !online);
    // The new process re-sends what was not acked (deduplicated) and gets the note turn from the outbox.
    claudeWorker = await gw.connect(studio.workerId, studio.credential, undefined, { claude: true });
    claudeWorker.link.send({ case: "threadEvent", value: shutdown });
    const turns = await eventually(() => noteTurns(threadId), (t) => t.length === 1 && t[0]!.status === "completed");
    expect(claudeWorker.started.get(turns[0]!.id)?.text).toContain("shut down for a restart or deploy");
    await gw.core.backgroundTasks.tick();
    await Bun.sleep(300);
    expect(await noteTurns(threadId)).toHaveLength(1);
    expect(claudeWorker.commands.filter((c) => c.case === "startTurn" && c.value.thread?.threadId === threadId)).toHaveLength(1);
  }, 30_000);

  test("Claude resume: a task-notification acknowledgement before the note's answer keeps one note turn", async () => {
    const threadId = await newThread(Provider.CLAUDE);
    await startTask(claudeWorker, threadId, "bg:old-task", "old-task");
    const messages = readFileSync(new URL("../../apps/worker/src/providers/claude/fixtures/background-resume-ack.jsonl", import.meta.url), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Parameters<ClaudeEventMapper["map"]>[0]);
    claudeWorker.handlers.set("startTurn", (value, reply) => {
      const { turnId } = value as { turnId: string };
      reply(true);
      claudeWorker.emit(threadId, turnId, { case: "turnStarted", value: { origin: TurnOrigin.COMMAND } });
      const mapper = new ClaudeEventMapper(turnId);
      // The real resumed-session order, through the same mapper and turn-start classification as the adapter.
      for (const message of messages) {
        if (!mapper.turnId && startsTurn(message)) {
          const providerTurn = Bun.randomUUIDv7();
          mapper.beginTurn(providerTurn);
          claudeWorker.emit(threadId, providerTurn, { case: "turnStarted", value: { origin: TurnOrigin.PROVIDER } });
        }
        for (const init of mapper.map(message)) claudeWorker.emit(threadId, init.turnId ?? "", init.body, init.rawJson);
      }
    });
    try {
      claudeWorker.emit(threadId, "", { case: "itemCompleted", value: { item: ended("bg:old-task", "old-task", ItemStatus.INTERRUPTED, { kind: BackgroundTaskKind.SHELL, stopReason: "worker_shutdown" }) } });
      const state = await eventually(() => snapshot(threadId), (s) => s.items.some((i) => i.item?.content.case === "agentMessage") && s.turns.every((t) => t.status === "completed"));
      const note = state.turns.find((t) => t.trigger === "background_task")!;
      expect(note.status).toBe("completed");
      expect(state.items.filter((i) => i.turnId === note.id && i.item?.content.case === "agentMessage").map((i) => i.item?.content.value)).toEqual([
        expect.objectContaining({ text: expect.stringContaining("worker shut down for a restart or deploy") }),
      ]);
      expect(state.turns.map((t) => t.trigger)).toEqual(["user", "background_task"]);
      await gw.core.backgroundTasks.tick();
      expect(await noteTurns(threadId)).toHaveLength(1);
    } finally {
      claudeWorker.handlers.delete("startTurn");
    }
  }, 30_000);

  test("Claude: a completion Claude wakes up for itself gets no second turn; without its wake-up the note comes after the grace", async () => {
    const threadId = await newThread(Provider.CLAUDE);
    await startTask(claudeWorker, threadId, "bg:task-c1", "c1");
    claudeWorker.emit(threadId, "", { case: "itemCompleted", value: { item: ended("bg:task-c1", "c1", ItemStatus.COMPLETED, { kind: BackgroundTaskKind.SHELL }) } });
    // Claude starts its own turn about it (task_notification).
    const wake = Bun.randomUUIDv7();
    claudeWorker.emit(threadId, wake, { case: "turnStarted", value: { origin: TurnOrigin.PROVIDER } });
    claudeWorker.emit(threadId, wake, { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } });
    await Bun.sleep(GRACE_MS + 300);
    await gw.core.backgroundTasks.tick();
    expect(await noteTurns(threadId)).toHaveLength(0);
    expect((await snapshot(threadId)).turns.filter((t) => t.trigger === "provider")).toHaveLength(1);

    // No wake-up this time (e.g. Claude Code exited): the platform tells the agent after the grace period.
    claudeWorker.emit(threadId, "", { case: "itemStarted", value: { item: task("bg:task-c2", "c2", "") } });
    claudeWorker.emit(threadId, "", { case: "itemCompleted", value: { item: ended("bg:task-c2", "c2", ItemStatus.COMPLETED, { kind: BackgroundTaskKind.SHELL }) } });
    await gw.core.backgroundTasks.tick();
    expect(await noteTurns(threadId)).toHaveLength(0); // still within the grace
    await Bun.sleep(GRACE_MS + 200);
    await gw.core.backgroundTasks.tick();
    const turns = await eventually(() => noteTurns(threadId), (t) => t.length === 1);
    expect(turns[0]?.backgroundItemIds).toEqual(["bg:task-c2"]);
  }, 30_000);

  test("stopped by the user: no wake-up turn; the note joins the next turn", async () => {
    const threadId = await newThread();
    const worker = gw.worker;
    await startTask(worker, threadId, "bg:exec-5", "105");
    worker.handlers.set("stopTask", (_value, reply) => {
      reply(true);
      worker.emit(threadId, "", { case: "itemCompleted", value: { item: ended("bg:exec-5", "105", ItemStatus.INTERRUPTED, { stopReason: "stopped_by_user" }) } });
    });
    try {
      await gw.api.stopBackgroundTask({ threadId, itemId: "bg:exec-5" });
      await eventually(() => gw.api.getThread({ threadId }), (r) => r.thread?.backgroundTasks === 0);
      await gw.core.backgroundTasks.tick();
      await Bun.sleep(200);
      expect(await noteTurns(threadId)).toHaveLength(0);
      worker.holdTurns = true;
      await gw.api.sendMessage({ threadId, text: "what next?", clientRequestId: "next-5" });
      const steer = await eventually(async () => [...worker.steered.values()].find((t) => t.includes("bg:exec-5")), (t) => t !== undefined);
      expect(steer).toContain("stopped by the user");
      const running = (await snapshot(threadId)).turns.find((t) => t.status === "running")!;
      worker.finish(threadId, running.id);
      await eventually(() => gw.api.getThread({ threadId }), (r) => r.thread?.status === "idle");
    } finally {
      worker.holdTurns = false;
      worker.handlers.delete("stopTask");
    }
  }, 30_000);

  test("a steer that cannot join falls back to a note turn, never a user turn", async () => {
    const threadId = await newThread();
    const worker = gw.worker;
    await startTask(worker, threadId, "bg:exec-6", "106");
    worker.holdTurns = true;
    worker.steerMode = "not_running";
    try {
      await gw.api.sendMessage({ threadId, text: "busy", clientRequestId: "hold-6" });
      const running = (await eventually(() => snapshot(threadId), (s) => s.turns.some((t) => t.status === "running"))).turns.find((t) => t.status === "running")!;
      worker.emit(threadId, "", { case: "itemCompleted", value: { item: ended("bg:exec-6", "106", ItemStatus.COMPLETED, { exitCode: 0 }) } });
      await eventually(() => snapshot(threadId), (s) => s.steers.some((x) => x.backgroundItemIds.includes("bg:exec-6") && x.status === "failed"));
      worker.holdTurns = false;
      worker.finish(threadId, running.id);
      const turns = await eventually(() => noteTurns(threadId), (t) => t.length === 1 && t[0]!.status === "completed");
      expect(turns[0]?.backgroundItemIds).toEqual(["bg:exec-6"]);
      expect((await snapshot(threadId)).turns.filter((t) => t.trigger === "user")).toHaveLength(2);
    } finally {
      worker.holdTurns = false;
      worker.steerMode = "accept";
    }
  }, 30_000);

  test("hop limit: a task started by a turn at the limit does not wake the thread", async () => {
    const threadId = await newThread();
    const worker = gw.worker;
    const turnId = await startTask(worker, threadId, "bg:exec-7", "107");
    await gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // As if an agent chain had started it (the constraint lets agent_bus turns carry hops).
      yield* sql`UPDATE turns SET trigger = 'agent_bus', agent_call_id = NULL, hops = 8 WHERE id = ${turnId}::uuid`.pipe(Effect.ignore);
    }));
    const hops = await gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return (yield* sql<{ hops: number }>`SELECT hops FROM turns WHERE id = ${turnId}::uuid`)[0]?.hops;
    }));
    worker.emit(threadId, "", { case: "itemCompleted", value: { item: ended("bg:exec-7", "107", ItemStatus.COMPLETED, { exitCode: 0 }) } });
    await eventually(() => gw.api.getThread({ threadId }), (r) => r.thread?.backgroundTasks === 0);
    await gw.core.backgroundTasks.tick();
    await Bun.sleep(200);
    expect(await noteTurns(threadId)).toHaveLength(hops === 8 ? 0 : 1);
  }, 30_000);

  test("tools: list and get report status, reason in words, times and output; stop asks the worker and brings no note", async () => {
    const threadId = await newThread();
    const worker = gw.worker;
    const turnId = await startTask(worker, threadId, "bg:exec-8", "108", "line 1\nline 2\nline 3\n");
    const json = (r: { content: string; isError: boolean }) => (r.isError ? { error: r.content } : JSON.parse(r.content));
    const listed = json(await worker.callTool({ threadId, tool: "list_background_tasks", args: {} }));
    expect(listed.tasks).toEqual([expect.objectContaining({ task_id: "bg:exec-8", provider_task_id: "108", status: "running", reason: "still running", started_in_turn_id: turnId, started_in_turn: 1, kind: "process" })]);
    const got = json(await worker.callTool({ threadId, tool: "get_background_task", args: { task_id: "108", output_lines: 2 } }));
    expect(got).toMatchObject({ task_id: "bg:exec-8", status: "running", output: "line 2\nline 3", output_truncated: true });
    expect(got.started_at).toBeString();
    expect(json(await worker.callTool({ threadId, tool: "get_background_task", args: { task_id: "nope" } })).error).toContain("not found");
    // Another thread of the same owner: readable (like get_thread), stopping only a descendant's.
    const other = await newThread();
    expect(json(await worker.callTool({ threadId, tool: "list_background_tasks", args: { thread_id: other } }))).toMatchObject({ tasks: [] });
    expect(json(await worker.callTool({ threadId, tool: "stop_background_task", args: { task_id: "1", thread_id: other } })).error).toContain("not found in your thread tree");

    worker.handlers.set("stopTask", (_value, reply) => {
      reply(true);
      worker.emit(threadId, "", { case: "itemCompleted", value: { item: ended("bg:exec-8", "108", ItemStatus.INTERRUPTED, { stopReason: "stopped_by_user" }) } });
    });
    try {
      expect(json(await worker.callTool({ threadId, tool: "stop_background_task", args: { task_id: "bg:exec-8" } }))).toMatchObject({ task_id: "bg:exec-8", stopping: true });
      expect(worker.commands.filter((c) => c.case === "stopTask").at(-1)?.value).toMatchObject({ threadId, taskId: "108" });
      await eventually(() => gw.api.getThread({ threadId }), (r) => r.thread?.backgroundTasks === 0);
      const after = json(await worker.callTool({ threadId, tool: "get_background_task", args: { task_id: "bg:exec-8" } }));
      expect(after).toMatchObject({ status: "interrupted", stop_reason: "stopped_by_user", reason: "stopped by the user" });
      expect(after.ended_at).toBeString();
      expect(json(await worker.callTool({ threadId, tool: "stop_background_task", args: { task_id: "bg:exec-8" } })).error).toContain("not running");
      // The agent stopped it itself: the next turn gets no note about it.
      worker.holdTurns = true;
      const steered = worker.steered.size;
      await gw.api.sendMessage({ threadId, text: "and now?", clientRequestId: "next-8" });
      const running = (await eventually(() => snapshot(threadId), (s) => s.turns.some((t) => t.status === "running"))).turns.find((t) => t.status === "running")!;
      await gw.core.backgroundTasks.tick();
      await Bun.sleep(200);
      expect(worker.steered.size).toBe(steered);
      worker.finish(threadId, running.id);
    } finally {
      worker.holdTurns = false;
      worker.handlers.delete("stopTask");
    }
  }, 30_000);
});
