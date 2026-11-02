import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, type AgentToolResult } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

const questions = [{ id: "auth", header: "Auth method", question: "Which method?", kind: "single_choice", options: [{ label: "OAuth" }, { label: "Password" }], recommended: "OAuth" }];
const answerJson = JSON.stringify({ answers: [{ id: "auth", kind: "choice", labels: ["OAuth"] }] });
const json = (result: AgentToolResult) => JSON.parse(result.content) as { status: string; question_set_id: string; answers: unknown[] };
describe.skipIf(!dockerAvailable)("ask_user (gateway + scripted worker)", () => {
  let gw: TestGateway;
  let projectId = "";
  let workspaceId = "";
  const query = <A extends object>(text: string, ...params: unknown[]) => gw.runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<A>(text, params as never[]);
  }));
  const turns = (id: string) => query<{ id: string; status: string; trigger: string; hops: number; text: string }>("SELECT id, status, trigger, hops, input->>'text' AS text FROM turns WHERE thread_id = $1::uuid ORDER BY ordinal", id);
  const pending = async (id: string) => {
    const updates = await watchUntil(gw.api, id, (u) => u.length > 0);
    return updates[0]?.change.case === "snapshot" ? updates[0].change.value.interactions : [];
  };
  const start = async () => {
    gw.worker.holdTurns = true;
    const thread = (await gw.api.createThread({ projectId, workspaceId, title: "Questions", provider: Provider.CODEX, initialMessage: "work" })).thread!;
    const running = await eventually(() => turns(thread.id), (r) => r[0]?.status === "running");
    return { threadId: thread.id, turnId: running[0]!.id };
  };
  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Questions" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo", label: "" })).workspace!.id;
  }, 60_000);
  afterAll(async () => { await gw?.close(); });

  test("sync stays blocked, then returns structured answers, with one durable question and timeline record", async () => {
    const source = await start();
    const callId = Bun.randomUUIDv7();
    let resolved = false;
    const waiting = gw.worker.callTool({ ...source, callId, tool: "ask_user", args: { questions, wait: true } }).then((r) => { resolved = true; return r; });
    const requests = await eventually(() => pending(source.threadId), (r) => r.length === 1);
    expect(resolved).toBe(false);
    expect(requests[0]).toMatchObject({ requestId: callId, asynchronous: false, status: "pending" });
    expect((await gw.api.getThread({ threadId: source.threadId })).thread?.pendingInteractions).toBe(1);
    expect(await failure(gw.api.answerInteraction({ requestId: callId, answerJson: '{"answers":[]}' }))).toContain("answer or explicitly skip");
    await gw.api.answerInteraction({ requestId: callId, answerJson });
    expect(json(await waiting)).toEqual({ question_set_id: callId, status: "answered", answers: [{ id: "auth", kind: "choice", labels: ["OAuth"] }] });
    const again = await gw.worker.callTool({ ...source, callId, tool: "ask_user", args: { questions, wait: true } });
    expect(json(again)).toEqual(json(await waiting));
    expect(await query("SELECT status, answer_delivery FROM interaction_requests WHERE id = $1::uuid", callId)).toEqual([{ status: "answered", answer_delivery: "consumed" }]);
    const items = await query<{ content: { interactionPrompt: object } }>("SELECT content FROM thread_items WHERE thread_id = $1::uuid AND type = 'interaction_prompt'", source.threadId);
    expect(items).toHaveLength(1);
    expect(items[0]?.content.interactionPrompt).toMatchObject({ outcome: "answered", answeredByUserId: gw.userId, responseJson: answerJson });
    gw.worker.finish(source.threadId, source.turnId);
    await eventually(() => turns(source.threadId), (r) => r[0]?.status === "completed");
    expect(await turns(source.threadId)).toHaveLength(1);
  });

  test("async returns immediately; answering steers into the running turn with asking hops + 1", async () => {
    const parent = await start();
    const child = json(await gw.worker.callTool({ ...parent, tool: "spawn_thread", args: { title: "Async child", prompt: "ask", notify: false, interactions: "human" } })) as unknown as { thread_id: string; turn_id: string };
    const source = { threadId: child.thread_id, turnId: child.turn_id };
    await eventually(() => turns(source.threadId), (r) => r[0]?.status === "running");
    const result = json(await gw.worker.callTool({ ...source, tool: "ask_user", args: { questions, wait: false } }));
    expect(result.status).toBe("pending");
    expect((await gw.api.getThread({ threadId: source.threadId })).thread?.pendingInteractions).toBe(0);
    await gw.api.answerInteraction({ requestId: result.question_set_id, answerJson });
    const rows = await eventually(() => query<{ status: string; hops: number; text: string }>("SELECT status, hops, input->>'text' AS text FROM turn_steers WHERE thread_id = $1::uuid", source.threadId), (r) => r[0]?.status === "delivered");
    expect(rows[0]).toMatchObject({ status: "delivered", hops: 2, text: expect.stringContaining('"labels":["OAuth"]') });
    expect(await turns(source.threadId)).toHaveLength(1);
    expect(json(await gw.worker.callTool({ ...source, tool: "get_answers", args: { question_set_id: result.question_set_id } })).status).toBe("answered");
    gw.worker.finish(source.threadId, source.turnId);
    gw.worker.finish(parent.threadId, parent.turnId);
  });

  test("async answer after the turn ends starts a new turn; skipped answers remain explicit", async () => {
    const source = await start();
    const result = json(await gw.worker.callTool({ ...source, tool: "ask_user", args: { questions, wait: false } }));
    gw.worker.finish(source.threadId, source.turnId);
    await eventually(() => turns(source.threadId), (r) => r[0]?.status === "completed");
    await gw.core.sweep();
    expect((await pending(source.threadId))[0]?.status).toBe("pending");
    gw.worker.holdTurns = false;
    await gw.api.answerInteraction({ requestId: result.question_set_id, answerJson: JSON.stringify({ answers: [{ id: "auth", kind: "skipped" }] }) });
    const next = await eventually(() => turns(source.threadId), (r) => r.length === 2 && r[1]?.status === "completed");
    expect(next[1]).toMatchObject({ trigger: "agent_bus", hops: 1, text: expect.stringContaining('"kind":"skipped"') });
    await gw.core.bus.deliverAnswers();
    expect(await turns(source.threadId)).toHaveLength(2);
  });

  test("a refused async steer falls back to a new turn with the same hops and answer", async () => {
    const source = await start();
    gw.worker.steerMode = "not_running";
    const result = json(await gw.worker.callTool({ ...source, tool: "ask_user", args: { questions, wait: false } }));
    await gw.api.answerInteraction({ requestId: result.question_set_id, answerJson });
    const next = await eventually(() => turns(source.threadId), (r) => r.length === 2);
    expect(next[1]).toMatchObject({ status: "queued", trigger: "agent_bus", hops: 1, text: expect.stringContaining('"labels":["OAuth"]') });
    gw.worker.steerMode = "accept";
    gw.worker.holdTurns = false;
    gw.worker.finish(source.threadId, source.turnId);
    await eventually(() => turns(source.threadId), (r) => r.every((t) => t.status === "completed"));
  });

  test("sync dismissal returns dismissed; async get_answers cannot read another thread's question", async () => {
    const source = await start();
    const callId = Bun.randomUUIDv7();
    const waiting = gw.worker.callTool({ ...source, callId, tool: "ask_user", args: { questions, wait: true } });
    await eventually(() => pending(source.threadId), (r) => r.length === 1);
    await gw.api.answerInteraction({ requestId: callId, cancelled: true });
    expect(json(await waiting)).toEqual({ question_set_id: callId, status: "dismissed", answers: [] });
    const other = await start();
    const denied = await gw.worker.callTool({ ...other, tool: "get_answers", args: { question_set_id: callId } });
    expect([denied.isError, denied.content]).toEqual([true, "question set not found in this thread"]);
    gw.worker.finish(source.threadId, source.turnId);
    gw.worker.finish(other.threadId, other.turnId);
  });

  test("side-thread questions route to the parent; parent and human can answer", async () => {
    const source = await start();
    const child = json(await gw.worker.callTool({ ...source, tool: "spawn_thread", args: { title: "Child", prompt: "ask", notify: false } })) as unknown as { thread_id: string; turn_id: string };
    await eventually(() => turns(child.thread_id), (r) => r[0]?.status === "running");
    const callId = Bun.randomUUIDv7();
    const waiting = gw.worker.callTool({ threadId: child.thread_id, turnId: child.turn_id, callId, tool: "ask_user", args: { questions, wait: true } });
    const forward = await eventually(() => query<{ hops: number }>("SELECT hops FROM turns WHERE interaction_request_id = $1::uuid", callId), (r) => r.length === 1);
    expect(forward[0]?.hops).toBe(2);
    expect((await pending(child.thread_id))[0]?.routedTo).toBe("parent");
    const answered = await gw.worker.callTool({ ...source, tool: "answer_interaction", args: { request_id: callId, response: "answer", answer_json: answerJson } });
    expect(answered.isError).toBe(false);
    expect(json(await waiting).status).toBe("answered");
    const second = json(await gw.worker.callTool({ threadId: child.thread_id, turnId: child.turn_id, tool: "ask_user", args: { questions, wait: false } }));
    await gw.api.answerInteraction({ requestId: second.question_set_id, answerJson });
    expect(await query("SELECT answered_by FROM interaction_requests WHERE id = $1::uuid", second.question_set_id)).toEqual([{ answered_by: gw.userId }]);
    gw.worker.holdTurns = false;
    gw.worker.finish(child.thread_id, child.turn_id);
    gw.worker.finish(source.threadId, source.turnId);
  });

  test("worker restart while waiting keeps the question; the answer resumes as a new turn", async () => {
    const added = await gw.addWorker("restart", ["/repo"]);
    const worker = await gw.connect(added.workerId, added.credential, undefined, { hello: { capabilities: ["running_turns"] } });
    worker.holdTurns = true;
    const ws = (await gw.api.createWorkspace({ projectId, workerId: added.workerId, rootPath: "/repo", label: "restart" })).workspace!.id;
    const thread = (await gw.api.createThread({ projectId, workspaceId: ws, provider: Provider.CODEX, title: "Restart", initialMessage: "ask" })).thread!;
    const running = await eventually(() => turns(thread.id), (r) => r[0]?.status === "running");
    const turnId = running[0]!.id;
    const callId = Bun.randomUUIDv7();
    const waiting = worker.callTool({ threadId: thread.id, turnId, callId, tool: "ask_user", args: { questions, wait: true } });
    void waiting.catch(() => {});
    await eventually(() => pending(thread.id), (r) => r.length === 1);
    worker.link.close();
    await gw.connect(added.workerId, added.credential, undefined, { hello: { capabilities: ["running_turns"], runningTurns: [] } });
    await eventually(() => turns(thread.id), (r) => r[0]?.status === "interrupted");
    expect((await pending(thread.id))[0]?.requestId).toBe(callId);
    await gw.api.answerInteraction({ requestId: callId, answerJson });
    const resumed = await eventually(() => turns(thread.id), (r) => r.length === 2 && r[1]?.status === "completed");
    expect(resumed[1]).toMatchObject({ trigger: "agent_bus", hops: 1, text: expect.stringContaining('"labels":["OAuth"]') });
  });
});
