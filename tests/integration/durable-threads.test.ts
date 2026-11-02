/**
 * Threads survive restarts and errors (docs/durability.md, "Stany tury i wątku"): whatever ends a turn — a worker
 * restart, a harness crash, an error on either side — nothing of it stays open, the turn says how it ended and who or
 * what ended it, and the thread takes the next message. Gateway on PostgreSQL + scripted workers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InteractionKind, ItemDeltaField, ItemStatus, PermissionMode, Provider, TurnEndSource, TurnOutcome, ui } from "@open-agents/contracts";
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
interface TurnState {
  id: string;
  status: string;
  text: string;
  interrupt_source: string | null;
  interrupt_reason: string | null;
  error_source: string | null;
  error_code: string | null;
  error: string | null;
}
const turns = (threadId: string) =>
  query<TurnState>(
    "SELECT id, status, input->>'text' AS text, interrupt_source, interrupt_reason, error_source, error_code, error FROM turns WHERE thread_id = $1::uuid ORDER BY ordinal",
    threadId,
  );
const items = (threadId: string) =>
  query<{ item_id: string; status: string }>("SELECT item_id, status FROM thread_items WHERE thread_id = $1::uuid AND type <> 'interaction_prompt' ORDER BY first_seq", threadId);
const threadStatus = async (threadId: string) => (await query<{ status: string }>("SELECT status FROM threads WHERE id = $1::uuid", threadId))[0]?.status;
const snapshotOf = async (threadId: string) => {
  const updates = await watchUntil(gw.api, threadId, (u) => u.some((x) => x.change.case === "snapshot"));
  return updates.find((u) => u.change.case === "snapshot")!.change.value as ui.ThreadSnapshot;
};

async function reconnect(runningTurns: { threadId: string; turnId: string }[]): Promise<ScriptedWorker> {
  worker.link.close();
  await eventually(async () => gw.core.online.has(edge.workerId), (online) => !online);
  worker = await gw.connect(edge.workerId, edge.credential, undefined, { hello: { capabilities: ["running_turns"], runningTurns } });
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

/** A new message runs and completes: the thread is usable. */
async function usable(threadId: string, text: string) {
  worker.holdTurns = false;
  await gw.api.sendMessage({ threadId, text, clientRequestId: `u-${text}` });
  const all = await eventually(() => turns(threadId), (t) => t.at(-1)?.text === text && t.at(-1)?.status === "completed");
  expect(await threadStatus(threadId)).toBe("idle");
  return all;
}

describe.skipIf(!dockerAvailable)("durable threads (gateway + scripted worker)", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    edge = await gw.addWorker("edge", ["/edge"]);
    worker = await gw.connect(edge.workerId, edge.credential);
    projectId = (await gw.api.createProject({ name: "Durable" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: edge.workerId, rootPath: "/edge/app" })).workspace!.id;
    await eventually(() => gw.api.getOverview({}), (o) => o.workers.every((w) => w.appliedVersion === 2n));
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("restart mid-turn: the turn is interrupted by the system, its open items end (live), the harness's late record wins", async () => {
    const { threadId, turnId } = await runningThread("restart-items");
    // The turn runs a command (with output so far), a nested tool call inside a subagent, and streams reasoning.
    worker.emit(threadId, turnId, { case: "itemStarted", value: { item: { itemId: "cmd-1", status: ItemStatus.IN_PROGRESS, content: { case: "commandExecution", value: { command: "sleep 40" } } } } });
    worker.emit(threadId, turnId, { case: "itemDelta", value: { itemId: "cmd-1", field: ItemDeltaField.OUTPUT, chunk: "partial output" } });
    worker.emit(threadId, turnId, { case: "itemStarted", value: { item: { itemId: "agent-1", status: ItemStatus.IN_PROGRESS, content: { case: "subagent", value: { agentType: "explorer" } } } } });
    worker.emit(threadId, turnId, {
      case: "itemStarted",
      value: { item: { itemId: "tool-1", parentItemId: "agent-1", status: ItemStatus.IN_PROGRESS, content: { case: "toolCall", value: { name: "grep" } } } },
    });
    worker.emit(threadId, turnId, { case: "itemStarted", value: { item: { itemId: "rs-1", status: ItemStatus.IN_PROGRESS, content: { case: "reasoning", value: {} } } } });
    const requestId = Bun.randomUUIDv7();
    worker.ask({ requestId, threadId, turnId, kind: InteractionKind.PERMISSION, toolName: "shell", requestJson: "{}" });
    await eventually(() => items(threadId), (i) => i.length === 4);
    await eventually(() => query<{ status: string }>("SELECT status FROM interaction_requests WHERE id = $1::uuid", requestId), (r) => r[0]?.status === "pending");

    // Watch the thread like the UI does: the closing events arrive live.
    const live = watchUntil(gw.api, threadId, (u) =>
      ["cmd-1", "agent-1", "tool-1", "rs-1"].every((id) =>
        u.some((x) => x.change.case === "event" && x.change.value.event?.body.case === "itemCompleted" && x.change.value.event.body.value.item?.itemId === id),
      ),
    );
    const restarted = await reconnect([]);
    const [turn] = await eventually(() => turns(threadId), (t) => t[0]?.status === "interrupted");
    expect(turn).toMatchObject({ interrupt_source: "system", interrupt_reason: "worker restarted" });
    expect(await eventually(() => items(threadId), (i) => i.every((x) => x.status === "interrupted"))).toHaveLength(4);
    await live;
    // Nothing waits any more: the question expired, the thread is idle.
    expect((await query<{ status: string }>("SELECT status FROM interaction_requests WHERE id = $1::uuid", requestId))[0]?.status).toBe("expired");
    expect(await threadStatus(threadId)).toBe("idle");
    // The audit trail of what the gateway closed.
    const audit = await query<{ item_id: string; reason: string }>(
      "SELECT item_id, raw->>'reason' AS reason FROM thread_events WHERE thread_id = $1::uuid AND origin = 'gateway' AND raw->>'reason' IS NOT NULL ORDER BY seq",
      threadId,
    );
    expect(audit.map((a) => a.item_id).sort()).toEqual(["agent-1", "cmd-1", "rs-1", "tool-1"]);
    expect(audit[0]?.reason).toContain("worker restarted");
    // The output the command showed is kept.
    const snapshot = await snapshotOf(threadId);
    expect(snapshot.items.find((i) => i.item?.content.case === "interactionPrompt")?.item?.content).toMatchObject({ case: "interactionPrompt", value: { outcome: "expired" } });
    const command = snapshot.items.find((i) => i.item?.itemId === "cmd-1")?.item;
    expect(command?.content).toMatchObject({ case: "commandExecution", value: { output: "partial output" } });
    expect(snapshot.turns[0]).toMatchObject({ status: "interrupted", interruptSource: "system", interruptReason: "worker restarted" });

    // The restarted worker settles the turn from the harness transcript: the command really failed, the turn completed.
    restarted.emit(threadId, turnId, {
      case: "itemCompleted",
      value: { item: { itemId: "cmd-1", status: ItemStatus.FAILED, content: { case: "commandExecution", value: { command: "sleep 40", exitCode: 143 } } } },
    });
    restarted.emit(threadId, turnId, { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED, providerTurnRef: "ct-x" } });
    await eventually(() => turns(threadId), (t) => t[0]?.status === "completed");
    expect((await turns(threadId))[0]).toMatchObject({ interrupt_source: null, interrupt_reason: null });
    expect((await items(threadId)).find((i) => i.item_id === "cmd-1")?.status).toBe("failed");
    await usable(threadId, "after restart");
  }, 30_000);

  test("harness crash: the turn failed in the harness with its code, open items end, the thread takes the next message", async () => {
    const { threadId, turnId } = await runningThread("crash");
    worker.emit(threadId, turnId, { case: "itemStarted", value: { item: { itemId: "cmd-c", status: ItemStatus.IN_PROGRESS, content: { case: "commandExecution", value: { command: "make" } } } } });
    // What the worker reports when the Codex app-server exits mid-turn and its rollout has no end.
    worker.emit(threadId, turnId, {
      case: "turnFinished",
      value: { outcome: TurnOutcome.FAILED, source: TurnEndSource.HARNESS, reason: "harness process exited (code 137)", errorCode: "process_exit" },
    });
    const [turn] = await eventually(() => turns(threadId), (t) => t[0]?.status === "failed");
    expect(turn).toMatchObject({ error_source: "harness", error_code: "process_exit", error: "harness process exited (code 137)" });
    await eventually(() => items(threadId), (i) => i.find((x) => x.item_id === "cmd-c")?.status === "interrupted");
    const snapshot = await snapshotOf(threadId);
    expect(snapshot.thread?.status).toBe("idle");
    expect(snapshot.turns[0]).toMatchObject({ status: "failed", errorSource: "harness", errorCode: "process_exit" });
    await usable(threadId, "after crash");
  }, 30_000);

  test("a turn that cannot start fails on the platform side (or the harness's when it refused); the thread stays usable", async () => {
    worker.holdTurns = false;
    const thread = (
      await gw.api.createThread({ projectId, workspaceId, title: "no-start", provider: Provider.CODEX, permissionMode: PermissionMode.ASK, clientRequestId: "c-no-start" })
    ).thread!;
    await eventually(() => threadStatus(thread.id), (s) => s === "idle");
    worker.handlers.set("startTurn", (_value, reply) => reply(false, { errorCode: "PROVIDER_UNAVAILABLE", errorMessage: "codex is disabled" }));
    await gw.api.sendMessage({ threadId: thread.id, text: "first", clientRequestId: "ns-1" });
    expect((await eventually(() => turns(thread.id), (t) => t[0]?.status === "failed"))[0]).toMatchObject({
      error_source: "platform",
      error_code: "PROVIDER_UNAVAILABLE",
      error: "codex is disabled",
    });
    worker.handlers.set("startTurn", (_value, reply) => reply(false, { errorCode: "HARNESS_ERROR", errorMessage: "turn/start: model not found" }));
    await gw.api.sendMessage({ threadId: thread.id, text: "second", clientRequestId: "ns-2" });
    expect((await eventually(() => turns(thread.id), (t) => t[1]?.status === "failed"))[1]).toMatchObject({ error_source: "harness", error_code: "HARNESS_ERROR" });
    expect(await threadStatus(thread.id)).toBe("idle");
    worker.handlers.delete("startTurn");
    await usable(thread.id, "third");
  }, 30_000);

  test("the sweep fixes what no turn end settled, with an audit reason, idempotently", async () => {
    worker.holdTurns = false;
    const created = await gw.api.createThread({ projectId, workspaceId, title: "sweep", provider: Provider.CODEX, permissionMode: PermissionMode.ASK, clientRequestId: "c-sweep", initialMessage: "go" });
    const threadId = created.thread!.id;
    const [turn] = await eventually(() => turns(threadId), (t) => t[0]?.status === "completed");
    // Rows like the ones an older gateway left behind: an item open in a finished turn, an interrupted thread status,
    // a question of a finished turn still pending.
    await query(
      `INSERT INTO thread_items (thread_id, item_id, turn_id, type, status, content, first_seq, last_seq)
       VALUES ($1::uuid, 'stale-cmd', $2::uuid, 'command_execution', 'in_progress', '{"itemId":"stale-cmd","status":"ITEM_STATUS_IN_PROGRESS","commandExecution":{"command":"sleep 40"}}', 1, 1)`,
      threadId,
      turn!.id,
    );
    await query("UPDATE threads SET status = 'interrupted' WHERE id = $1::uuid", threadId);
    await query(
      `INSERT INTO interaction_requests (id, thread_id, turn_id, kind, tool_name, request, routed_to) VALUES ($1::uuid, $2::uuid, $3::uuid, 'permission', 'shell', '{}', 'human')`,
      Bun.randomUUIDv7(),
      threadId,
      turn!.id,
    );
    expect(await gw.core.sweep()).toContain(threadId);
    expect((await items(threadId)).find((i) => i.item_id === "stale-cmd")?.status).toBe("interrupted");
    expect(await threadStatus(threadId)).toBe("idle");
    expect((await query<{ n: number }>("SELECT count(*)::int AS n FROM interaction_requests WHERE thread_id = $1::uuid AND status = 'pending'", threadId))[0]?.n).toBe(0);
    const [audit] = await query<{ reason: string }>("SELECT raw->>'reason' AS reason FROM thread_events WHERE thread_id = $1::uuid AND origin = 'gateway' AND raw->>'reason' LIKE '%sweep%'", threadId);
    expect(audit?.reason).toContain("sweep");
    expect(await gw.core.sweep()).not.toContain(threadId);
    await usable(threadId, "after sweep");
  }, 30_000);
});
