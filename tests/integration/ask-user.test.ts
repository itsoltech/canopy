import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Code } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { AgentToolCallSchema, Provider, TurnOutcome, ui, type AgentToolResult } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

const questions = [
  {
    id: "auth",
    header: "Auth method",
    question: "Which method?",
    kind: "single_choice",
    options: [{ label: "OAuth" }, { label: "Password" }],
    recommended: "OAuth",
  },
];

const answerJson = JSON.stringify({ answers: [{ id: "auth", kind: "choice", labels: ["OAuth"] }] });

const json = (result: AgentToolResult) =>
  JSON.parse(result.content) as { status: string; question_set_id: string; answers: unknown[] };

describe.skipIf(!dockerAvailable)("ask_user (gateway + scripted worker)", () => {
  let gw: TestGateway;
  let projectId = "";
  let workspaceId = "";

  const query = <A extends object>(text: string, ...params: unknown[]) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(text, params as never[]);
      }),
    );

  const turns = (id: string) =>
    query<{ id: string; status: string; trigger: string; hops: number; text: string }>(
      "SELECT id, status, trigger, hops, input->>'text' AS text FROM turns WHERE thread_id = $1::uuid ORDER BY ordinal",
      id,
    );

  const pending = async (id: string) => {
    const updates = await watchUntil(gw.api, id, (u) => u.length > 0);

    return updates[0]?.change.case === "snapshot" ? updates[0].change.value.interactions : [];
  };

  const uiTurn = async (threadId: string, turnId: string) => {
    const updates = await watchUntil(gw.api, threadId, (u) => u.length > 0);

    return updates[0]?.change.case === "snapshot"
      ? updates[0].change.value.turns.find((t) => t.id === turnId)
      : undefined;
  };

  const start = async () => {
    gw.worker.holdTurns = true;

    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        title: "Questions",
        provider: Provider.CODEX,
        initialMessage: "work",
      })
    ).thread!;

    const running = await eventually(
      () => turns(thread.id),
      (r) => r[0]?.status === "running",
    );

    return { threadId: thread.id, turnId: running[0]!.id };
  };

  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Questions" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo", label: "" }))
      .workspace!.id;
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  test("sync stays blocked, then returns structured answers, with one durable question and timeline record", async () => {
    const source = await start();
    const callId = Bun.randomUUIDv7();
    let resolved = false;

    const waiting = gw.worker
      .callTool({ ...source, callId, tool: "ask_user", args: { questions, wait: true } })
      .then((r) => {
        resolved = true;

        return r;
      });

    const requests = await eventually(
      () => pending(source.threadId),
      (r) => r.length === 1,
    );

    expect(resolved).toBe(false);
    expect(requests[0]).toMatchObject({ requestId: callId, asynchronous: false, status: "pending" });
    expect((await gw.api.getThread({ threadId: source.threadId })).thread?.pendingInteractions).toBe(1);
    expect(await failure(gw.api.answerInteraction({ requestId: callId, answerJson: '{"answers":[]}' }))).toContain(
      "answer or explicitly skip",
    );
    await gw.api.answerInteraction({ requestId: callId, answerJson });
    expect(json(await waiting)).toEqual({
      question_set_id: callId,
      status: "answered",
      answers: [{ id: "auth", kind: "choice", labels: ["OAuth"] }],
    });
    const again = await gw.worker.callTool({ ...source, callId, tool: "ask_user", args: { questions, wait: true } });
    expect(json(again)).toEqual(json(await waiting));
    expect(await query("SELECT status, answer_delivery FROM interaction_requests WHERE id = $1::uuid", callId)).toEqual(
      [{ status: "answered", answer_delivery: "consumed" }],
    );

    const items = await query<{ content: { interactionPrompt: object } }>(
      "SELECT content FROM thread_items WHERE thread_id = $1::uuid AND type = 'interaction_prompt'",
      source.threadId,
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.content.interactionPrompt).toMatchObject({
      outcome: "answered",
      answeredByUserId: gw.userId,
      responseJson: answerJson,
    });
    gw.worker.finish(source.threadId, source.turnId);
    await eventually(
      () => turns(source.threadId),
      (r) => r[0]?.status === "completed",
    );
    expect(await turns(source.threadId)).toHaveLength(1);
  });

  test("async returns immediately; answering steers into the running turn with asking hops + 1", async () => {
    const parent = await start();

    const child = JSON.parse(
      (
        await gw.worker.callTool({
          ...parent,
          tool: "spawn_thread",
          args: { title: "Async child", prompt: "ask", notify: false, interactions: "human" },
        })
      ).content,
    ) as { thread_id: string; turn_id: string };

    const source = { threadId: child.thread_id, turnId: child.turn_id };
    await eventually(
      () => turns(source.threadId),
      (r) => r[0]?.status === "running",
    );
    const result = json(await gw.worker.callTool({ ...source, tool: "ask_user", args: { questions, wait: false } }));
    expect(result.status).toBe("pending");
    expect((await gw.api.getThread({ threadId: source.threadId })).thread?.pendingInteractions).toBe(0);
    await gw.api.answerInteraction({ requestId: result.question_set_id, answerJson });

    const rows = await eventually(
      () =>
        query<{ status: string; hops: number; text: string }>(
          "SELECT status, hops, input->>'text' AS text FROM turn_steers WHERE thread_id = $1::uuid",
          source.threadId,
        ),
      (r) => r[0]?.status === "delivered",
    );

    expect(rows[0]).toMatchObject({
      status: "delivered",
      hops: 2,
      text: expect.stringContaining('"labels":["OAuth"]'),
    });
    expect(await turns(source.threadId)).toHaveLength(1);
    expect(
      json(
        await gw.worker.callTool({ ...source, tool: "get_answers", args: { question_set_id: result.question_set_id } }),
      ).status,
    ).toBe("answered");
    gw.worker.finish(source.threadId, source.turnId);
    gw.worker.finish(parent.threadId, parent.turnId);
  });

  test("async answer after the turn ends starts a new turn; skipped answers remain explicit", async () => {
    const source = await start();
    const result = json(await gw.worker.callTool({ ...source, tool: "ask_user", args: { questions, wait: false } }));
    gw.worker.finish(source.threadId, source.turnId);
    await eventually(
      () => turns(source.threadId),
      (r) => r[0]?.status === "completed",
    );
    await gw.core.sweep();
    expect((await pending(source.threadId))[0]?.status).toBe("pending");
    // The agent stopped: its open async question now waits for the user (Input required).
    expect((await gw.api.getThread({ threadId: source.threadId })).thread?.pendingInteractions).toBe(1);
    gw.worker.holdTurns = false;
    await gw.api.answerInteraction({
      requestId: result.question_set_id,
      answerJson: JSON.stringify({ answers: [{ id: "auth", kind: "skipped" }] }),
    });

    const next = await eventually(
      () => turns(source.threadId),
      (r) => r.length === 2 && r[1]?.status === "completed",
    );

    expect(next[1]).toMatchObject({ trigger: "agent_bus", hops: 1, text: expect.stringContaining('"kind":"skipped"') });
    // The UI shows it as your answer, not as a message from the asking thread itself.
    const answerTurn = await uiTurn(source.threadId, next[1]!.id);
    expect(answerTurn).toMatchObject({ sourceKind: "answer", sourceThreadId: "", botId: "" });
    await gw.core.bus.deliverAnswers();
    expect(await turns(source.threadId)).toHaveLength(2);
  });

  test("a bot answering on the user's behalf is named on the answer turn", async () => {
    const botId = Bun.randomUUIDv7();
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO bots(id, owner_user_id, client_request_id, configuration, provider, provider_instance) VALUES (${botId}::uuid, ${gw.userId}::uuid, ${botId}, '{}'::jsonb, 'codex', 'none')`;
      }),
    );
    const source = await start();
    const result = json(await gw.worker.callTool({ ...source, tool: "ask_user", args: { questions, wait: false } }));
    gw.worker.finish(source.threadId, source.turnId);
    await eventually(
      () => turns(source.threadId),
      (r) => r[0]?.status === "completed",
    );
    gw.worker.holdTurns = false;
    await gw.core.answerInteraction(
      create(ui.AnswerInteractionRequestSchema, {
        requestId: result.question_set_id,
        answerJson: JSON.stringify({ answers: [{ id: "auth", kind: "skipped" }] }),
      }),
      botId,
    );

    const next = await eventually(
      () => turns(source.threadId),
      (r) => r.length === 2,
    );

    const answerTurn = await uiTurn(source.threadId, next[1]!.id);
    expect(answerTurn).toMatchObject({ sourceKind: "answer", botId });
  });

  test("a refused async steer falls back to a new turn with the same hops and answer", async () => {
    const source = await start();
    gw.worker.steerMode = "not_running";
    const result = json(await gw.worker.callTool({ ...source, tool: "ask_user", args: { questions, wait: false } }));
    await gw.api.answerInteraction({ requestId: result.question_set_id, answerJson });

    const next = await eventually(
      () => turns(source.threadId),
      (r) => r.length === 2,
    );

    expect(next[1]).toMatchObject({
      status: "queued",
      trigger: "agent_bus",
      hops: 1,
      text: expect.stringContaining('"labels":["OAuth"]'),
    });
    gw.worker.steerMode = "accept";
    gw.worker.holdTurns = false;
    gw.worker.finish(source.threadId, source.turnId);
    await eventually(
      () => turns(source.threadId),
      (r) => r.every((t) => t.status === "completed"),
    );
  });

  test("an accepted async steer dropped by the harness is delivered as a new turn", async () => {
    const source = await start();
    gw.worker.steerMode = "drop";
    const result = json(await gw.worker.callTool({ ...source, tool: "ask_user", args: { questions, wait: false } }));
    await gw.api.answerInteraction({ requestId: result.question_set_id, answerJson });

    const next = await eventually(
      () => turns(source.threadId),
      (r) => r.length === 2,
    );

    expect(next[1]).toMatchObject({
      status: "queued",
      trigger: "agent_bus",
      hops: 1,
      text: expect.stringContaining('"labels":["OAuth"]'),
    });
    gw.worker.steerMode = "accept";
    gw.worker.holdTurns = false;
    gw.worker.finish(source.threadId, source.turnId);
    await eventually(
      () => turns(source.threadId),
      (r) => r.every((t) => t.status === "completed"),
    );
  });

  test("an unanswered sync request expires at turn end; an accepted answer survives a crash during delivery", async () => {
    for (const consumed of [false, true]) {
      const source = await start();
      const callId = Bun.randomUUIDv7();
      const waiting = gw.worker.callTool({ ...source, callId, tool: "ask_user", args: { questions, wait: true } });
      await eventually(
        () => pending(source.threadId),
        (r) => r.length === 1,
      );

      if (consumed) {
        await gw.api.answerInteraction({ requestId: callId, answerJson });
        expect(json(await waiting).status).toBe("answered");
      }

      gw.worker.emit(source.threadId, source.turnId, {
        case: "turnFinished",
        value: { outcome: TurnOutcome.INTERRUPTED },
      });
      await eventually(
        () => turns(source.threadId),
        (r) => r[0]?.status === "interrupted",
      );

      if (!consumed) {
        await expect(gw.api.answerInteraction({ requestId: callId, answerJson })).rejects.toMatchObject({
          code: Code.FailedPrecondition,
        });
        expect(json(await waiting).status).toBe("expired");
        await gw.core.bus.deliverAnswers();
        expect(await turns(source.threadId)).toHaveLength(1);
        continue;
      }

      await gw.core.bus.deliverAnswers();

      const next = await eventually(
        () => turns(source.threadId),
        (r) => r.length === 2,
      );

      expect(next[1]).toMatchObject({
        trigger: "agent_bus",
        hops: 1,
        text: expect.stringContaining('"labels":["OAuth"]'),
      });
      await gw.core.bus.deliverAnswers();
      expect(await turns(source.threadId)).toHaveLength(2);
      gw.worker.holdTurns = false;
      gw.worker.finish(source.threadId, next[1]!.id);
      await waiting;
    }
  });

  test("cancellation arriving before a synchronous question fences its later replay", async () => {
    const source = await start();
    const callId = Bun.randomUUIDv7();
    gw.worker.link.send({
      case: "agentToolCall",
      value: create(AgentToolCallSchema, {
        ...source,
        callId,
        toolName: "ask_user",
        argumentsJson: JSON.stringify({ questions, wait: true }),
        cancelled: true,
      }),
    });

    const rows = await eventually(
      () => query<{ status: string }>("SELECT status FROM interaction_requests WHERE id = $1::uuid", callId),
      (r) => r[0]?.status === "expired",
    );

    expect(rows).toEqual([{ status: "expired" }]);
    expect(
      json(await gw.worker.callTool({ ...source, callId, tool: "ask_user", args: { questions, wait: true } })).status,
    ).toBe("expired");
    expect(await pending(source.threadId)).toEqual([]);
    await expect(
      gw.core.answerInteraction(create(ui.AnswerInteractionRequestSchema, { requestId: callId, answerJson })),
    ).rejects.toThrow("This request expired.");
    expect(await turns(source.threadId)).toHaveLength(1);
    gw.worker.finish(source.threadId, source.turnId);
  });

  test("sync dismissal returns dismissed; async get_answers cannot read another thread's question", async () => {
    const source = await start();
    const callId = Bun.randomUUIDv7();
    const waiting = gw.worker.callTool({ ...source, callId, tool: "ask_user", args: { questions, wait: true } });
    await eventually(
      () => pending(source.threadId),
      (r) => r.length === 1,
    );
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

    const child = JSON.parse(
      (
        await gw.worker.callTool({
          ...source,
          tool: "spawn_thread",
          args: { title: "Child", prompt: "ask", notify: false },
        })
      ).content,
    ) as { thread_id: string; turn_id: string };

    await eventually(
      () => turns(child.thread_id),
      (r) => r[0]?.status === "running",
    );
    const callId = Bun.randomUUIDv7();

    const waiting = gw.worker.callTool({
      threadId: child.thread_id,
      turnId: child.turn_id,
      callId,
      tool: "ask_user",
      args: { questions, wait: true },
    });

    const forward = await eventually(
      () => query<{ hops: number }>("SELECT hops FROM turns WHERE interaction_request_id = $1::uuid", callId),
      (r) => r.length === 1,
    );

    expect(forward[0]?.hops).toBe(2);
    expect((await pending(child.thread_id))[0]?.routedTo).toBe("parent");

    const answered = await gw.worker.callTool({
      ...source,
      tool: "answer_interaction",
      args: { request_id: callId, response: "answer", answer_json: answerJson },
    });

    expect(answered.isError).toBe(false);
    expect(json(await waiting).status).toBe("answered");

    const second = json(
      await gw.worker.callTool({
        threadId: child.thread_id,
        turnId: child.turn_id,
        tool: "ask_user",
        args: { questions, wait: false },
      }),
    );

    await gw.api.answerInteraction({ requestId: second.question_set_id, answerJson });
    expect(
      await query("SELECT answered_by FROM interaction_requests WHERE id = $1::uuid", second.question_set_id),
    ).toEqual([{ answered_by: gw.userId }]);

    const finalCallId = Bun.randomUUIDv7();

    const finalQuestion = gw.worker.callTool({
      threadId: child.thread_id,
      turnId: child.turn_id,
      callId: finalCallId,
      tool: "ask_user",
      args: { questions, wait: true },
    });

    await eventually(
      () => pending(child.thread_id),
      (r) => r.some((q) => q.requestId === finalCallId),
    );
    gw.worker.finish(child.thread_id, child.turn_id);
    expect(json(await finalQuestion).status).toBe("expired");

    const lateParentAnswer = await gw.worker.callTool({
      ...source,
      tool: "answer_interaction",
      args: { request_id: finalCallId, response: "answer", answer_json: answerJson },
    });

    expect(lateParentAnswer.isError).toBe(true);
    expect(await query("SELECT status, response FROM interaction_requests WHERE id = $1::uuid", finalCallId)).toEqual([
      { status: "expired", response: null },
    ]);
    gw.worker.holdTurns = false;
    gw.worker.finish(source.threadId, source.turnId);
  });

  test("worker restart expires an unanswered synchronous question", async () => {
    const added = await gw.addWorker("restart", ["/repo"]);

    const worker = await gw.connect(added.workerId, added.credential, undefined, {
      hello: { capabilities: ["running_turns"] },
    });

    worker.holdTurns = true;

    const ws = (
      await gw.api.createWorkspace({ projectId, workerId: added.workerId, rootPath: "/repo", label: "restart" })
    ).workspace!.id;

    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId: ws,
        provider: Provider.CODEX,
        title: "Restart",
        initialMessage: "ask",
      })
    ).thread!;

    const running = await eventually(
      () => turns(thread.id),
      (r) => r[0]?.status === "running",
    );

    const turnId = running[0]!.id;
    const callId = Bun.randomUUIDv7();
    // The old connection cannot receive its tool result. Await the gateway handler itself before
    // disposing its runtime, and prove that restart reconciliation releases the original wait.
    const original = gw.core.bus.handle.bind(gw.core.bus);
    let handling: Promise<AgentToolResult> | undefined;

    const spy = spyOn(gw.core.bus, "handle").mockImplementation((...args) => {
      const result = original(...args);

      if (args[0].callId === callId) handling = result;

      return result;
    });

    try {
      const waiting = worker.callTool({
        threadId: thread.id,
        turnId,
        callId,
        tool: "ask_user",
        args: { questions, wait: true },
      });

      void waiting.catch(() => {});
      await eventually(
        () => pending(thread.id),
        (r) => r.length === 1,
      );
      worker.link.close();
      await gw.connect(added.workerId, added.credential, undefined, {
        hello: { capabilities: ["running_turns"], runningTurns: [] },
      });
      await eventually(
        () => turns(thread.id),
        (r) => r[0]?.status === "interrupted",
      );
      await eventually(
        () => pending(thread.id),
        (r) => r.length === 0,
      );
      expect(json((await handling)!).status).toBe("expired");
      expect((await handling)?.isError).toBe(false);
      await expect(
        gw.api.answerInteraction({ requestId: callId, answerJson }, { timeoutMs: 5000 }),
      ).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: "This request expired." });
      expect(await turns(thread.id)).toHaveLength(1);
    } finally {
      spy.mockRestore();

      if (handling) await handling;
    }
  }, 15_000);
});
