/**
 * Harness goals and provider background work through the gateway (docs/goals.md, docs/execution.md):
 * UI API -> core -> worker commands (SetGoal, StartTurn with /goal, StopTask) -> scripted worker ->
 * goal_state and background_task events -> ingest -> UI (Thread, snapshot, live updates).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@connectrpc/connect";
import {
  BackgroundTaskKind,
  GoalDirective,
  ItemDeltaField,
  ItemStatus,
  PermissionMode,
  Provider,
  TurnOrigin,
  TurnOutcome,
  ui,
  type SetGoal,
} from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { eventually, failure, startTestGateway, watchUntil, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let api: Client<typeof ui.GatewayService>;

describe.skipIf(!dockerAvailable)("harness goals and background work (gateway)", () => {
  let projectId = "";
  let codexWorkspace = "";
  let claudeWorkspace = "";
  let claudeWorker: ScriptedWorker;

  beforeAll(async () => {
    gw = await startTestGateway();
    api = gw.api;
    const studio = await gw.addWorker("studio", ["/studio"]);
    claudeWorker = await gw.connect(studio.workerId, studio.credential, undefined, { claude: true });
    projectId = (await api.createProject({ name: "Goals" })).project!.id;
    codexWorkspace = (await api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/a" })).workspace!.id;
    claudeWorkspace = (await api.createWorkspace({ projectId, workerId: studio.workerId, rootPath: "/studio/b" })).workspace!.id;
    // Both workers have applied their configuration before threads are checked against it.
    await eventually(() => api.getOverview({}), (o) => o.workers.every((w) => w.appliedVersion === 2n));
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  const newThread = async (provider: Provider) => {
    const thread = (
      await api.createThread({ projectId, workspaceId: provider === Provider.CLAUDE ? claudeWorkspace : codexWorkspace, title: "g", provider, permissionMode: PermissionMode.ASK })
    ).thread!;
    await eventually(() => api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle");
    return thread.id;
  };
  const goalOf = async (threadId: string) => {
    const updates = await watchUntil(api, threadId, (u) => u.some((x) => x.change.case === "snapshot"));
    const snapshot = updates.find((u) => u.change.case === "snapshot")!.change.value as ui.ThreadSnapshot;
    return { goal: snapshot.goal, turns: snapshot.turns, items: snapshot.items };
  };
  const commandsOf = (worker: ScriptedWorker, kind: string) => worker.commands.filter((c) => c.case === kind).map((c) => c.value);
  const goalCommands = (worker: ScriptedWorker) => worker.commands.flatMap((c) => (c.case === "setGoal" ? [c.value as SetGoal] : []));

  test("Codex: set, harness continuation turns, pause, resume, clear — status, usage and turns tracked", async () => {
    const threadId = await newThread(Provider.CODEX);
    const worker = gw.worker;
    const set = await api.setGoal({ threadId, action: "set", objective: "Ship the release", tokenBudget: 50_000n });
    expect(set.goal).toMatchObject({ objective: "Ship the release", status: "active", createdBy: "user", tokenBudget: 50_000n });
    const command = await eventually(async () => goalCommands(worker).at(-1), (c) => c !== undefined);
    expect(command).toMatchObject({ threadId, directive: GoalDirective.RUN, objective: "Ship the release", nativeTokenBudget: 50_000n, thread: { threadId } });

    // Codex confirms, then continues the thread by itself.
    worker.emit(threadId, "", { case: "goalState", value: { nativeStatus: "active", objective: "Ship the release", tokenBudget: 50_000n } });
    const turnId = Bun.randomUUIDv7();
    worker.emit(threadId, turnId, { case: "turnStarted", value: { providerTurnRef: "c1", origin: TurnOrigin.PROVIDER } });
    worker.emit(threadId, turnId, { case: "goalState", value: { nativeStatus: "active", objective: "Ship the release", tokensUsed: 1200n, timeUsedSeconds: 3n } });
    worker.emit(threadId, turnId, { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED, providerTurnRef: "c1" } });
    const live = await watchUntil(api, threadId, (u) => u.some((x) => x.change.case === "goal" && x.change.value.tokensUsed === 1200n));
    expect(live.some((u) => u.change.case === "goal")).toBe(true);
    let state = await goalOf(threadId);
    expect(state.goal).toMatchObject({ status: "active", tokensUsed: 1200n, timeUsedSeconds: 3n, iterations: 1, nativeStatus: "active" });
    expect(state.turns.find((t) => t.id === turnId)).toMatchObject({ trigger: "provider", goalId: set.goal!.id });
    expect((await api.getThread({ threadId })).thread?.goalStatus).toBe("active");

    // Pause: recorded at once, a late "active" progress report does not undo it.
    expect((await api.setGoal({ threadId, action: "pause" })).goal?.status).toBe("paused");
    await eventually(async () => goalCommands(worker).at(-1)?.directive, (d) => d === GoalDirective.PAUSE);
    worker.emit(threadId, "", { case: "goalState", value: { nativeStatus: "active", objective: "Ship the release", tokensUsed: 1300n } });
    worker.emit(threadId, "", { case: "goalState", value: { nativeStatus: "paused", objective: "Ship the release", tokensUsed: 1300n } });
    state = await eventually(() => goalOf(threadId), (s) => s.goal?.nativeStatus === "paused");
    expect(state.goal?.status).toBe("paused");

    expect((await api.setGoal({ threadId, action: "resume" })).goal?.status).toBe("active");
    const resume = await eventually(async () => goalCommands(worker).at(-1), (c) => c?.directive === GoalDirective.RUN && c.objective === "");
    expect(resume?.objective).toBe("");
    expect((await api.setGoal({ threadId, action: "clear" })).goal?.status).toBe("cancelled");
    await eventually(async () => goalCommands(worker).at(-1)?.directive, (d) => d === GoalDirective.CLEAR);
    worker.emit(threadId, "", { case: "goalState", value: { cleared: true } });
    state = await eventually(() => goalOf(threadId), (s) => s.goal?.nativeStatus === "cleared");
    expect(state.goal).toMatchObject({ status: "cancelled" });
    expect(state.goal?.finishedAt).toBeDefined();
    expect((await api.getThread({ threadId })).thread?.goalStatus).toBe("");
    expect(await failure(api.setGoal({ threadId, action: "pause" }))).toContain("no active goal");
  }, 30_000);

  test("Codex: a goal the harness reports as complete is achieved; a goal the model set itself is tracked", async () => {
    const threadId = await newThread(Provider.CODEX);
    await api.setGoal({ threadId, action: "set", objective: "Write docs" });
    gw.worker.emit(threadId, "", { case: "goalState", value: { nativeStatus: "complete", objective: "Write docs", tokensUsed: 900n } });
    let state = await eventually(() => goalOf(threadId), (s) => s.goal?.status === "achieved");
    expect(state.goal).toMatchObject({ status: "achieved", createdBy: "user" });
    // The model sets a new goal on its own (Codex create_goal).
    gw.worker.emit(threadId, "", { case: "goalState", value: { nativeStatus: "active", objective: "Fix the flaky test" } });
    state = await eventually(() => goalOf(threadId), (s) => s.goal?.objective === "Fix the flaky test");
    expect(state.goal).toMatchObject({ status: "active", createdBy: "provider" });
  }, 30_000);

  test("Claude: /goal turns; pause interrupts the goal turn and clears; the evaluator's verdict achieves it", async () => {
    const threadId = await newThread(Provider.CLAUDE);
    const turns: { turnId: string; text: string }[] = [];
    claudeWorker.handlers.set("startTurn", (value, reply) => {
      const start = value as { turnId: string; input?: { text: string } };
      turns.push({ turnId: start.turnId, text: start.input?.text ?? "" });
      reply(true);
      claudeWorker.emit(threadId, start.turnId, { case: "turnStarted", value: { origin: TurnOrigin.COMMAND } });
    });
    claudeWorker.handlers.set("interruptTurn", (value, reply) => {
      reply(true);
      const { turnId } = value as { turnId: string };
      claudeWorker.emit(threadId, turnId, { case: "turnFinished", value: { outcome: TurnOutcome.INTERRUPTED, reason: "interrupted" } });
    });
    const set = await api.setGoal({ threadId, action: "set", objective: "All tests pass" });
    expect(await failure(api.setGoal({ threadId, action: "set", objective: "x", tokenBudget: 10n }))).toContain("no token budget");
    const first = await eventually(async () => turns[0], (t) => t !== undefined);
    expect(first?.text).toBe("/goal All tests pass");
    claudeWorker.emit(threadId, first!.turnId, { case: "goalState", value: { nativeStatus: "active", objective: "All tests pass" } });
    claudeWorker.emit(threadId, first!.turnId, { case: "goalState", value: { nativeStatus: "active", objective: "All tests pass", iterations: 1, lastReason: "2 tests fail" } });
    let state = await eventually(() => goalOf(threadId), (s) => s.goal?.iterations === 1);
    expect(state.goal).toMatchObject({ status: "active", lastReason: "2 tests fail" });
    expect(state.turns.find((t) => t.id === first!.turnId)).toMatchObject({ trigger: "goal", goalId: set.goal!.id, inputText: "/goal All tests pass" });

    // Pause: the running goal turn is interrupted, then /goal clear runs; the clear keeps the goal paused.
    expect((await api.setGoal({ threadId, action: "pause" })).goal?.status).toBe("paused");
    const clear = await eventually(async () => turns[1], (t) => t !== undefined);
    expect(clear?.text).toBe("/goal clear");
    expect(commandsOf(claudeWorker, "interruptTurn").length).toBeGreaterThanOrEqual(1);
    claudeWorker.emit(threadId, clear!.turnId, { case: "goalState", value: { nativeStatus: "cleared", cleared: true, objective: "All tests pass" } });
    claudeWorker.emit(threadId, clear!.turnId, { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } });
    state = await eventually(() => goalOf(threadId), (s) => s.goal?.nativeStatus === "cleared");
    expect(state.goal?.status).toBe("paused");

    // Resume sets the goal again; the evaluator's verdict completes it.
    await api.setGoal({ threadId, action: "resume" });
    const again = await eventually(async () => turns[2], (t) => t !== undefined);
    expect(again?.text).toBe("/goal All tests pass");
    claudeWorker.emit(threadId, again!.turnId, { case: "goalState", value: { nativeStatus: "met", objective: "All tests pass", iterations: 2, lastReason: "bun test: 0 fail" } });
    claudeWorker.emit(threadId, again!.turnId, { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } });
    state = await eventually(() => goalOf(threadId), (s) => s.goal?.status === "achieved");
    expect(state.goal).toMatchObject({ status: "achieved", iterations: 2, lastReason: "bun test: 0 fail" });
  }, 30_000);

  test("background process: outlives its turn, streams output, no phantom turns, stopped from the UI", async () => {
    const threadId = await newThread(Provider.CODEX);
    const worker = gw.worker;
    let turnId = "";
    worker.handlers.set("startTurn", (value, reply) => {
      turnId = (value as { turnId: string }).turnId;
      reply(true);
      worker.emit(threadId, turnId, { case: "turnStarted", value: { origin: TurnOrigin.COMMAND } });
      worker.emit(threadId, turnId, {
        case: "itemStarted",
        value: { item: { itemId: "exec-1", status: ItemStatus.IN_PROGRESS, content: { case: "commandExecution", value: { command: "npm run dev" } } } },
      });
      worker.emit(threadId, turnId, {
        case: "itemStarted",
        value: {
          item: {
            itemId: "bg:exec-1",
            status: ItemStatus.IN_PROGRESS,
            content: { case: "backgroundTask", value: { taskId: "4242", processId: "4242", kind: BackgroundTaskKind.PROCESS, command: "npm run dev", startedInTurnId: turnId, sourceItemId: "exec-1", output: "ready\n" } },
          },
        },
      });
      worker.emit(threadId, turnId, { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } });
    });
    await api.sendMessage({ threadId, text: "start the dev server", clientRequestId: "bg-1" });
    await eventually(() => api.getThread({ threadId }), (r) => r.thread?.backgroundTasks === 1 && r.thread.status === "idle");
    worker.handlers.delete("startTurn");

    // After the turn: output outside any turn, and an event naming a turn the thread never had.
    worker.emit(threadId, "", { case: "itemDelta", value: { itemId: "bg:exec-1", field: ItemDeltaField.OUTPUT, chunk: "GET / 200\n" } });
    worker.emit(threadId, Bun.randomUUIDv7(), { case: "itemDelta", value: { itemId: "bg:exec-1", field: ItemDeltaField.OUTPUT, chunk: "GET /a 200\n" } });
    let state = await eventually(
      () => goalOf(threadId),
      (s) => s.items.some((i) => i.item?.content.case === "backgroundTask" && i.item.content.value.output.includes("GET /a")),
    );
    expect(state.turns.map((t) => t.id)).toEqual([turnId]);
    const item = state.items.find((i) => i.item?.itemId === "bg:exec-1");
    expect(item?.turnId).toBe(turnId);
    expect(item?.item?.content.case === "backgroundTask" && item.item.content.value.output).toBe("ready\nGET / 200\nGET /a 200\n");

    worker.handlers.set("stopTask", (value, reply) => {
      reply(true);
      const { taskId } = value as { taskId: string };
      worker.emit(threadId, "", {
        case: "itemCompleted",
        value: { item: { itemId: "bg:exec-1", status: ItemStatus.INTERRUPTED, content: { case: "backgroundTask", value: { taskId, kind: BackgroundTaskKind.PROCESS, command: "npm run dev", stopReason: "stopped_by_user" } } } },
      });
    });
    await api.stopBackgroundTask({ threadId, itemId: "bg:exec-1" });
    expect(commandsOf(worker, "stopTask").at(-1)).toMatchObject({ threadId, taskId: "4242" });
    await eventually(() => api.getThread({ threadId }), (r) => r.thread?.backgroundTasks === 0);
    state = await goalOf(threadId);
    const stopped = state.items.find((i) => i.item?.itemId === "bg:exec-1")?.item;
    expect(stopped?.status).toBe(ItemStatus.INTERRUPTED);
    // Output streamed before the stop is kept.
    expect(stopped?.content.case === "backgroundTask" && stopped.content.value.output).toContain("GET /a 200");
    expect(await failure(api.stopBackgroundTask({ threadId, itemId: "bg:exec-1" }))).toContain("not running");
    expect(await failure(api.stopBackgroundTask({ threadId, itemId: "exec-1" }))).toContain("background task not found");
  }, 30_000);
});
