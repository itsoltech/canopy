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
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

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
    const later = await gw.worker.callTool({ threadId: mainId, tool: "schedule_wakeup", args: { prompt: "x", delay_seconds: 600 } });
    expect(later.content).toBe("schedule_wakeup is not available yet");
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

  test("close_thread archives the side thread; it no longer counts or receives messages", async () => {
    const onceId = (await query<{ id: string }>("SELECT id FROM threads WHERE title = 'Once'"))[0]!.id;
    const closed = await gw.worker.callTool({ threadId: mainId, tool: "close_thread", args: { thread_id: onceId } });
    expect(json(closed)).toEqual({ thread_id: onceId, closed: true });
    const send = await gw.worker.callTool({ threadId: mainId, tool: "send_message", args: { thread_id: onceId, prompt: "x" } });
    expect(send.content).toBe("target thread is archived");
    const listed = json(await gw.worker.callTool({ threadId: mainId, tool: "list_threads", args: {} })) as { threads: { title: string }[] };
    expect(listed.threads.map((t) => t.title).sort()).toEqual(["Mine", "Reviewer"]);
  });
});
