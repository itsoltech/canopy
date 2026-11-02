/**
 * A worker that restarts (or reconnects) while the gateway believes turns run on it (docs/durability.md, 3.4):
 * Hello.running_turns reconciles them, an interrupt for a turn the worker does not run ends it, goal commands the
 * worker cannot carry out show on the goal (Goal.error), and a provider thread that had to be started again
 * replaces the stored one (thread_ready.replaces_provider_thread_id). Gateway on PostgreSQL + scripted workers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GoalDirective, InteractionKind, PermissionMode, Provider, ui, type SetGoal, type StartTurn } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, watchUntil, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let projectId = "";
let edge: { workerId: string; credential: string };
let workspaceId = "";
let worker: ScriptedWorker;

const query = <A extends object>(text: string, ...params: unknown[]) =>
  gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<A>(text, params as never[]);
    }),
  );
const turns = (threadId: string) =>
  query<{ id: string; status: string; text: string; interrupt_reason: string | null }>(
    "SELECT id, status, input->>'text' AS text, interrupt_reason FROM turns WHERE thread_id = $1::uuid ORDER BY ordinal",
    threadId,
  );
const snapshotOf = async (threadId: string) => {
  const updates = await watchUntil(gw.api, threadId, (u) => u.some((x) => x.change.case === "snapshot"));
  return updates.find((u) => u.change.case === "snapshot")!.change.value as ui.ThreadSnapshot;
};

/** The edge worker's process (re)starts: a new link, optionally with the running_turns report. */
async function reconnect(runningTurns?: { threadId: string; turnId: string }[]): Promise<ScriptedWorker> {
  worker.link.close();
  await eventually(async () => gw.core.online.has(edge.workerId), (online) => !online);
  worker = await gw.connect(edge.workerId, edge.credential, undefined, runningTurns ? { hello: { capabilities: ["running_turns"], runningTurns } } : {});
  await eventually(async () => gw.core.online.has(edge.workerId), (online) => online);
  return worker;
}

async function runningThread(title: string) {
  worker.holdTurns = true;
  const thread = (
    await gw.api.createThread({ projectId, workspaceId, title, provider: Provider.CODEX, permissionMode: PermissionMode.ASK, clientRequestId: `c-${title}`, initialMessage: "long task" })
  ).thread!;
  const [turn] = await eventually(() => turns(thread.id), (t) => t[0]?.status === "running");
  return { threadId: thread.id, turnId: turn!.id };
}

describe.skipIf(!dockerAvailable)("worker restart and lost turns (gateway + scripted worker)", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    edge = await gw.addWorker("edge", ["/edge"]);
    worker = await gw.connect(edge.workerId, edge.credential);
    projectId = (await gw.api.createProject({ name: "Restart" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: edge.workerId, rootPath: "/edge/app" })).workspace!.id;
    await eventually(() => gw.api.getOverview({}), (o) => o.workers.every((w) => w.appliedVersion === 2n));
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("restart mid-turn: the lost turn ends as interrupted, its interaction expires, the queue and the steer run next", async () => {
    const { threadId, turnId } = await runningThread("restart");
    await gw.api.sendMessage({ threadId, text: "next", clientRequestId: "q-1" });
    // The provider took the steer, then the process died before it joined the turn.
    worker.handlers.set("steerTurn", (_value, reply) => reply(true));
    const steer = (await gw.api.sendMessage({ threadId, text: "also this", clientRequestId: "s-1", delivery: ui.MessageDelivery.STEER })).steer!;
    await eventually(() => query<{ status: string }>("SELECT status FROM turn_steers WHERE id = $1::uuid", steer.id), (r) => r[0]?.status === "accepted");
    const requestId = Bun.randomUUIDv7();
    worker.ask({ requestId, threadId, turnId, kind: InteractionKind.PERMISSION, toolName: "shell", requestJson: "{}" });
    await eventually(() => query<{ status: string }>("SELECT status FROM interaction_requests WHERE id = $1::uuid", requestId), (r) => r[0]?.status === "pending");

    // Offline, the gateway cannot tell: the turn still looks running.
    worker.link.close();
    await eventually(async () => gw.core.online.has(edge.workerId), (online) => !online);
    expect((await turns(threadId))[0]?.status).toBe("running");

    // The new process runs nothing and says so.
    const restarted = await reconnect([]);
    const all = await eventually(() => turns(threadId), (t) => t.length === 3 && t.every((x) => x.status !== "running" && x.status !== "queued"));
    expect(all.map((t) => [t.status, t.text, t.interrupt_reason])).toEqual([
      ["interrupted", "long task", "worker restarted"],
      ["completed", "next", null],
      ["completed", "also this", null],
    ]);
    expect(restarted.inputs.get(threadId)).toEqual(["next", "also this"]);
    expect((await query<{ status: string }>("SELECT status FROM interaction_requests WHERE id = $1::uuid", requestId))[0]?.status).toBe("expired");
    expect((await query<{ status: string; reason: string }>("SELECT status, reason FROM turn_steers WHERE id = $1::uuid", steer.id))[0]).toMatchObject({
      status: "queued",
      reason: "the turn ended before the message could join it (worker restarted)",
    });
    const snapshot = await snapshotOf(threadId);
    expect(snapshot.thread?.status).toBe("idle");
    expect(snapshot.turns.find((t) => t.id === turnId)).toMatchObject({ status: "interrupted", interruptReason: "worker restarted" });
  }, 30_000);

  test("a reconnect keeps the turns the worker still runs; a late turn_finished sets the real outcome", async () => {
    const { threadId, turnId } = await runningThread("reconnect");
    const kept = await reconnect([{ threadId, turnId }]);
    await Bun.sleep(200);
    expect((await turns(threadId))[0]?.status).toBe("running");
    kept.finish(threadId, turnId);
    await eventually(() => turns(threadId), (t) => t[0]?.status === "completed");

    // The turn finished while the link was down and its end comes after the gateway closed the turn.
    const { threadId: other, turnId: lost } = await runningThread("late-end");
    const late = await reconnect([]);
    await eventually(() => turns(other), (t) => t[0]?.status === "interrupted");
    late.finish(other, lost);
    expect((await eventually(() => turns(other), (t) => t[0]?.status === "completed"))[0]?.interrupt_reason).toBeNull();
    expect((await gw.api.getThread({ threadId: other })).thread?.status).toBe("idle");
  }, 30_000);

  test("an interrupt for a turn the worker does not run ends it in the gateway (a worker without the running_turns report)", async () => {
    const { threadId, turnId } = await runningThread("interrupt");
    await gw.api.sendMessage({ threadId, text: "after", clientRequestId: "i-1" });
    const old = await reconnect(); // no capability: the gateway cannot judge, the turn stays running
    await Bun.sleep(200);
    expect((await turns(threadId))[0]?.status).toBe("running");
    old.handlers.set("interruptTurn", (_value, reply) => reply(false, { errorCode: "TURN_NOT_RUNNING", errorMessage: "the turn is not running on this worker" }));
    await gw.api.interruptThread({ threadId });
    const all = await eventually(() => turns(threadId), (t) => t[1]?.status === "completed");
    expect(all.map((t) => [t.id === turnId, t.status, t.interrupt_reason])).toEqual([
      [true, "interrupted", "the turn was no longer running on the worker"],
      [false, "completed", null],
    ]);
    old.handlers.delete("interruptTurn");
  }, 30_000);

  test("a goal command the worker cannot carry out shows on the goal; the status goes back; the next success clears it", async () => {
    worker.holdTurns = false;
    const thread = (
      await gw.api.createThread({ projectId, workspaceId, title: "goal", provider: Provider.CODEX, permissionMode: PermissionMode.ASK, clientRequestId: "c-goal" })
    ).thread!;
    expect(thread.runtime).toBe("worker");
    await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle");
    let fail = true;
    worker.handlers.set("setGoal", (_value, reply) =>
      fail ? reply(false, { errorCode: "THREAD_ERROR", errorMessage: "thread/resume: no rollout found for thread id x" }) : reply(true),
    );
    const goalCommands = () => worker.commands.flatMap((c) => (c.case === "setGoal" ? [c.value as SetGoal] : []));

    // Set fails: the harness never had the goal, it is blocked with the error (live too), not "starting" forever.
    await gw.api.setGoal({ threadId: thread.id, action: "set", objective: "Ship it", tokenBudget: 1000n });
    const live = await watchUntil(gw.api, thread.id, (u) => u.some((x) => x.change.case === "goal" && x.change.value.error !== ""));
    const failed = live.flatMap((u) => (u.change.case === "goal" || (u.change.case === "snapshot" && u.change.value.goal) ? [u.change.case === "goal" ? u.change.value : (u.change.value as ui.ThreadSnapshot).goal!] : [])).at(-1)!;
    expect(failed).toMatchObject({ status: "blocked", error: "THREAD_ERROR: thread/resume: no rollout found for thread id x" });
    expect(failed.errorAt).toBeDefined();
    expect((await gw.api.getThread({ threadId: thread.id })).thread?.goalStatus).toBe("blocked");

    // Resume sends the objective again (the harness never had it); the success clears the error.
    fail = false;
    expect((await gw.api.setGoal({ threadId: thread.id, action: "resume" })).goal?.error).toBe("");
    const resent = await eventually(async () => goalCommands().at(-1), (c) => c?.objective === "Ship it");
    expect(resent).toMatchObject({ directive: GoalDirective.RUN, objective: "Ship it", nativeTokenBudget: 1000n });
    worker.emit(thread.id, "", { case: "goalState", value: { nativeStatus: "active", objective: "Ship it" } });
    let goal = await eventually(async () => (await snapshotOf(thread.id)).goal, (g) => g?.nativeStatus === "active");
    expect(goal).toMatchObject({ status: "active", error: "" });

    // Pause and clear fail: back to what the harness last said (active), with the error.
    fail = true;
    await gw.api.setGoal({ threadId: thread.id, action: "pause" });
    goal = await eventually(async () => (await snapshotOf(thread.id)).goal, (g) => g?.error !== "");
    expect(goal).toMatchObject({ status: "active", error: "THREAD_ERROR: thread/resume: no rollout found for thread id x" });
    await gw.api.setGoal({ threadId: thread.id, action: "clear" });
    goal = await eventually(async () => (await snapshotOf(thread.id)).goal, (g) => g?.status === "active" && g.error !== "");
    expect(goal?.finishedAt).toBeUndefined();
    fail = false;
    await gw.api.setGoal({ threadId: thread.id, action: "clear" });
    goal = await eventually(async () => (await snapshotOf(thread.id)).goal, (g) => g?.status === "cancelled");
    expect(goal?.error).toBe("");
    worker.handlers.delete("setGoal");
  }, 30_000);

  test("Claude: a /goal turn that cannot start shows on the goal", async () => {
    const studio = await gw.addWorker("studio", ["/studio"]);
    const claude = await gw.connect(studio.workerId, studio.credential, undefined, { claude: true });
    const claudeWorkspace = (await gw.api.createWorkspace({ projectId, workerId: studio.workerId, rootPath: "/studio/b" })).workspace!.id;
    await eventually(() => gw.api.getOverview({}), (o) => o.workers.every((w) => w.appliedVersion === 2n));
    const thread = (
      await gw.api.createThread({ projectId, workspaceId: claudeWorkspace, title: "cg", provider: Provider.CLAUDE, permissionMode: PermissionMode.ASK, clientRequestId: "c-cg" })
    ).thread!;
    await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle");
    claude.handlers.set("startTurn", (_value, reply) => reply(false, { errorCode: "THREAD_ERROR", errorMessage: "Claude Code exited" }));
    await gw.api.setGoal({ threadId: thread.id, action: "set", objective: "All tests pass" });
    const goal = await eventually(async () => (await snapshotOf(thread.id)).goal, (g) => g?.error !== "");
    expect(goal?.error).toBe("THREAD_ERROR: Claude Code exited");
  }, 30_000);

  test("a provider thread started again replaces the stored one, only when it names it", async () => {
    worker.holdTurns = false;
    const thread = (
      await gw.api.createThread({ projectId, workspaceId, title: "replace", provider: Provider.CODEX, permissionMode: PermissionMode.ASK, clientRequestId: "c-replace" })
    ).thread!;
    await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle");
    const stored = async () => (await query<{ provider_thread_id: string }>("SELECT provider_thread_id FROM threads WHERE id = $1::uuid", thread.id))[0]?.provider_thread_id;
    const first = await stored();
    worker.emit(thread.id, "", { case: "threadReady", value: { providerThreadId: "codex-other", replacesProviderThreadId: "codex-unrelated" } });
    worker.emit(thread.id, "", { case: "threadReady", value: { providerThreadId: "codex-fresh", replacesProviderThreadId: first ?? "" } });
    await eventually(stored, (id) => id === "codex-fresh");
    await gw.api.sendMessage({ threadId: thread.id, text: "hi", clientRequestId: "r-1" });
    const start = await eventually(
      async () => worker.commands.flatMap((c) => (c.case === "startTurn" && (c.value as StartTurn).thread?.threadId === thread.id ? [c.value as StartTurn] : [])).at(-1),
      (c) => c !== undefined,
    );
    expect(start?.thread?.providerThreadId).toBe("codex-fresh");
  }, 30_000);
});
