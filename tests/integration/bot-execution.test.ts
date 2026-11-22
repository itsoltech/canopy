import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, fromJsonString } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import {
  AgentToolCallSchema,
  bots,
  InteractionKind,
  Provider,
  ThreadEventSchema,
  TurnOutcome,
  ui,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { uiRoutes } from "@canopy/gateway/api";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { startGrpcServer } from "@canopy/transport";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { deliverBotSteer } from "../../apps/gateway/src/core/bot-steer.ts";
import { eventually, startTestGateway, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

const capabilities = ["bot_harness_v1", "bot_web_v1", "bot_workspace_v1", "bot_steer_v1"];

describe.skipIf(!dockerAvailable)("bot execution summaries over gRPC", () => {
  let gw: TestGateway;
  let worker: ScriptedWorker;

  const query = <Row extends object>(text: string, values: string[]) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<Row>(text, values)));

  const add = async (name: string) =>
    (
      await gw.api.createBot({
        clientRequestId: crypto.randomUUID(),
        configuration: {
          name,
          shape: "round",
          color: "#22aaff",
          provider: Provider.CODEX,
          providerInstance: "native",
          model: "gpt-6.1-sol",
          approvalPolicy: "always",
          workerId: gw.workerId,
        },
      })
    ).bot!;

  const listed = async (id: string, api = gw.api) =>
    (await api.listBots({ includeArchived: true })).bots.find((b) => b.id === id);

  const read = (id: string) => gw.core.bots.run((s) => s.conversation(gw.userId, id));

  async function connect(threads: { threadId: string; lastSeq: bigint }[] = []) {
    worker = await gw.connect(gw.workerId, gw.workerCredential, undefined, { hello: { capabilities, threads } });
    expect(
      await eventually(async () => gw.core.link.connections.get(gw.workerId)?.registrationEpoch, Boolean),
    ).toBeDefined();
  }

  async function disconnect() {
    worker.link.close();
    expect(
      await eventually(
        async () => gw.core.online.has(gw.workerId),
        (online) => !online,
      ),
    ).toBe(false);
  }

  function watch(id: string, api = gw.api) {
    const controller = new AbortController();
    const updates: bots.Bot[] = [];

    const reading = (async () => {
      for await (const { change } of api.watchOverview({}, { signal: controller.signal }))
        if (change.case === "bot" && change.value.id === id) updates.push(change.value);
    })().catch((cause: Error) => {
      if (!controller.signal.aborted) throw cause;
    });

    const expectSummary = async (executing: boolean, after = 0) => {
      expect(
        await eventually(
          () => listed(id, api),
          (bot) => bot?.executing === executing,
        ),
      ).toMatchObject({ executing });
      expect(
        await eventually(async () => updates.slice(after).find((bot) => bot.executing === executing), Boolean),
      ).toMatchObject({ id, executing });
    };

    return {
      updates,
      expectSummary,
      close: async () => {
        controller.abort();
        await reading;
      },
    };
  }

  async function expectCommandAcknowledged(turnId: string) {
    expect(
      await eventually(
        () => query<{ status: string }>("SELECT status FROM worker_commands WHERE id=$1::uuid", [turnId]),
        ([command]) => command?.status === "completed",
      ),
    ).toEqual([{ status: "completed" }]);
  }

  async function requestDelegatedApproval(botId: string) {
    const project = (await gw.api.createProject({ name: "Delegated work" })).project!;

    const workspace = (
      await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo" })
    ).workspace!;

    const thread = (
      await gw.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        title: "Delegated thread",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!;

    await query("INSERT INTO bot_started_threads(thread_id,bot_id) VALUES($1::uuid,$2::uuid)", [thread.id, botId]);
    worker.holdTurns = true;

    const turn = (await gw.api.sendMessage({ threadId: thread.id, clientRequestId: crypto.randomUUID(), text: "Wait" }))
      .turn!;

    expect(await eventually(async () => worker.started.has(turn.id), Boolean)).toBe(true);
    const requestId = crypto.randomUUID();
    worker.ask({
      requestId,
      threadId: thread.id,
      turnId: turn.id,
      kind: InteractionKind.PERMISSION,
      toolName: "shell",
      requestJson: "{}",
    });

    expect(
      await eventually(
        () => listed(botId),
        (bot) => bot?.pendingApproval?.id === requestId,
      ),
    ).toMatchObject({ executing: true, pendingApproval: { id: requestId, threadId: thread.id } });
    await gw.api.answerInteraction({ requestId, allow: false });
    worker.finish(thread.id, turn.id);
    worker.holdTurns = false;
  }

  beforeAll(async () => {
    gw = await startTestGateway({ worker: { hello: { capabilities } } });
    worker = gw.worker;
  }, 30_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("requires a worker start, pauses for this turn's card and clears on finish after resuming", async () => {
    const { id } = await add("Worker admission");
    const stream = watch(id);
    const callId = crypto.randomUUID();
    let tool: Promise<unknown> | undefined;

    try {
      await stream.expectSummary(false);
      await disconnect();
      const turnId = await gw.core.bots.run((s) => s.enqueue(gw.userId, id, "Controlled work", crypto.randomUUID()));
      expect(await query("SELECT status FROM bot_turns WHERE id=$1::uuid", [turnId])).toEqual([{ status: "queued" }]);
      expect(await listed(id)).toMatchObject({ executing: false });
      await gw.core.bots.tick();

      const waiting = await eventually(
        () => read(id),
        (state) => state.statusLine.startsWith("Waiting for"),
      );

      expect(waiting.statusLine).toStartWith("Waiting for");
      expect(waiting.working).toBe(true);
      expect(await listed(id)).toMatchObject({ executing: false });

      await connect();
      await expectCommandAcknowledged(turnId);
      expect(await listed(id)).toMatchObject({ executing: false });
      worker.emit(id, turnId, { case: "turnStarted", value: {} });
      await stream.expectSummary(true);
      expect((await gw.api.getBot({ botId: id })).bot?.executing).toBeUndefined();
      await requestDelegatedApproval(id);

      const beforeQuestion = stream.updates.length;
      tool = gw.core.bots.harnessTools.handle(
        create(AgentToolCallSchema, {
          botId: id,
          threadId: id,
          turnId,
          callId,
          toolName: "ask_user",
          argumentsJson: JSON.stringify({ question: "Which task should I handle next?" }),
        }),
        gw.workerId,
      );

      const question = await eventually(
        () => listed(id),
        (bot) => bot?.pendingApproval?.kind === "question",
      );

      expect(question).toMatchObject({ executing: false, pendingApproval: { turnId, kind: "question" } });
      expect(await query("SELECT status FROM bot_turns WHERE id=$1::uuid", [turnId])).toEqual([{ status: "running" }]);
      await stream.expectSummary(false, beforeQuestion);

      const beforeAnswer = stream.updates.length;
      await gw.api.answerBotApproval({ approvalId: question!.pendingApproval!.id, approve: true, answer: "Proceed" });
      expect(await tool).toMatchObject({ isError: false });
      await stream.expectSummary(true, beforeAnswer);
      const other = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other@localhost", "Other")));
      expect(await gw.core.bots.run((s) => s.executions(other))).toEqual([]);

      const beforeFinish = stream.updates.length;
      worker.finish(id, turnId, "Completed work");
      await stream.expectSummary(false, beforeFinish);
      expect(
        (
          await eventually(
            () => read(id),
            (state) => !state.working,
          )
        ).messages.at(-1)?.text,
      ).toBe("Completed work");
    } finally {
      await gw.core.bots.remove(id);
      await tool;
      await stream.close();
    }
  }, 30_000);

  test("another gateway sees loss, reconnect and journal replay without owning the worker link", async () => {
    const { id } = await add("Worker reconnect");
    const reader = new GatewayCore({ runtime: gw.runtime, userId: gw.userId, instanceId: "api-replica" });
    const server = await startGrpcServer({ routes: uiRoutes(reader) });
    const api = createClient(ui.GatewayService, createGrpcTransport({ baseUrl: server.url }));
    const stream = watch(id, api);

    try {
      const { turnId } = await gw.api.sendBotMessage({ botId: id, text: "Wait", clientRequestId: crypto.randomUUID() });
      await expectCommandAcknowledged(turnId);

      const started = create(ThreadEventSchema, {
        eventId: Bun.randomUUIDv7(),
        threadId: id,
        turnId,
        journalSeq: 1n,
        body: { case: "turnStarted", value: {} },
      });

      worker.link.send({ case: "threadEvent", value: started });
      await stream.expectSummary(true);
      expect(reader.online.size).toBe(0);
      expect(await listed(id)).toMatchObject({ executing: true });

      const beforeLoss = stream.updates.length;
      await disconnect();
      await stream.expectSummary(false, beforeLoss);

      const beforeResume = stream.updates.length;
      // A pre-upgrade start already exists in the event journal, but has no projection yet.
      await query("UPDATE bot_harness_turns SET started_journal_id=NULL WHERE turn_id=$1::uuid", [turnId]);
      await connect();
      expect(await listed(id, api)).toMatchObject({ executing: false });
      worker.link.send({ case: "threadEvent", value: started });
      await stream.expectSummary(true, beforeResume);

      const beforeFinish = stream.updates.length;
      await disconnect();
      await stream.expectSummary(false, beforeFinish);
      // The disconnected worker had written a finish. The next Hello advertises its unacknowledged event.
      await connect([{ threadId: id, lastSeq: 2n }]);
      expect(await listed(id, api)).toMatchObject({ executing: false });
      expect(await query("SELECT status FROM bot_turns WHERE id=$1::uuid", [turnId])).toEqual([{ status: "running" }]);
      worker.link.send({ case: "threadEvent", value: started });
      worker.link.send({
        case: "threadEvent",
        value: create(ThreadEventSchema, {
          eventId: Bun.randomUUIDv7(),
          threadId: id,
          turnId,
          journalSeq: 2n,
          body: { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } },
        }),
      });
      expect(
        (
          await eventually(
            () => read(id),
            (state) => !state.working,
          )
        ).working,
      ).toBe(false);
      expect(await listed(id, api)).toMatchObject({ executing: false });
      expect(stream.updates.slice(beforeFinish).every((bot) => bot.executing === false)).toBe(true);
    } finally {
      await gw.core.bots.remove(id);
      await stream.close();
      await server.close();
    }
  }, 25_000);

  test("deleting a bot expires an unacknowledged start and delivers the stop after reconnect", async () => {
    const { id } = await add("Delete offline work");
    await disconnect();
    const { turnId } = await gw.api.sendBotMessage({ botId: id, text: "Wait", clientRequestId: crypto.randomUUID() });
    await eventually(
      () => query<{ status: string }>("SELECT status FROM worker_commands WHERE id=$1::uuid", [turnId]),
      ([command]) => command?.status === "pending",
    );

    await gw.api.deleteBot({ botId: id });

    const [stop] = await query<{ id: string; status: string }>(
      "SELECT id,status FROM worker_commands WHERE worker_id=$1::uuid AND kind='interruptBotTurn' AND status='pending'",
      [gw.workerId],
    );

    expect(stop).toBeDefined();
    expect(await query("SELECT status FROM worker_commands WHERE id=$1::uuid", [turnId])).toEqual([
      { status: "expired" },
    ]);
    expect(await query("SELECT status FROM bot_turns WHERE id=$1::uuid", [turnId])).toEqual([
      { status: "interrupted" },
    ]);
    await connect();
    await expectCommandAcknowledged(stop!.id);
    expect(worker.commands).toContainEqual({ case: "interruptBotTurn", value: expect.objectContaining({ turnId }) });
    expect(worker.commands.some((kind) => kind.case === "runBotTurn" && kind.value.turnId === turnId)).toBe(false);
    expect(
      await deliverBotSteer(gw.core, {
        botId: id,
        turnId,
        workerId: gw.workerId,
        inputId: crypto.randomUUID(),
        text: "Late steer",
      }),
    ).toBe(false);
    expect(worker.commands.some((kind) => kind.case === "steerBotTurn")).toBe(false);

    worker.emit(id, turnId, { case: "turnStarted", value: {} });
    worker.emit(id, turnId, { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } });
    await eventually(
      () => query<{ seq: number }>("SELECT last_seq::int AS seq FROM bot_harness_cursors WHERE bot_id=$1::uuid", [id]),
      ([cursor]) => cursor?.seq === 2,
    );
    expect(await query("SELECT outcome FROM bot_harness_turns WHERE turn_id=$1::uuid", [turnId])).toEqual([
      { outcome: TurnOutcome.INTERRUPTED },
    ]);
    expect(await listed(id)).toBeUndefined();
  }, 15_000);

  test("a running routine appears in summaries even though private chat is idle, then clears on archive", async () => {
    const { id } = await add("Scheduled work");
    const { userId, core } = gw;
    const stream = watch(id);

    try {
      const { turnId: setup } = await gw.api.sendBotMessage({
        botId: id,
        text: "Schedule a periodic check",
        clientRequestId: crypto.randomUUID(),
      });

      await expectCommandAcknowledged(setup);
      worker.emit(id, setup, { case: "turnStarted", value: {} });

      const result = await core.bots.harnessTools.handle(
        create(AgentToolCallSchema, {
          botId: id,
          threadId: id,
          turnId: setup,
          callId: crypto.randomUUID(),
          toolName: "create_routine",
          argumentsJson: JSON.stringify({
            title: "Periodic check",
            instructions: "Check quietly",
            cron: "*/15 * * * *",
            timezone: "UTC",
          }),
        }),
        gw.workerId,
      );

      const routine = fromJsonString(bots.BotRoutineSchema, result.resultJson);
      worker.finish(id, setup, "Scheduled");
      expect(
        await eventually(
          async () => (await read(id)).messages.at(-1)?.text,
          (text) => text === "Scheduled",
        ),
      ).toBe("Scheduled");
      await core.bots.run((s) => s.deliverRoutines(userId, timestampDate(routine.nextRunAt!)));

      const turns = await query<{ id: string }>("SELECT id FROM bot_turns WHERE routine_id=$1::uuid", [routine.id]);

      expect(turns).toHaveLength(1);
      const turnId = turns[0]!.id;

      await stream.expectSummary(false);
      await core.bots.tick();
      await expectCommandAcknowledged(turnId);
      const beforeStart = stream.updates.length;
      worker.emit(id, turnId, { case: "turnStarted", value: {} });
      await stream.expectSummary(true, beforeStart);
      expect((await read(id)).working).toBe(false);

      const beforeArchive = stream.updates.length;
      await gw.api.archiveBot({ botId: id });
      await stream.expectSummary(false, beforeArchive);
      expect(await listed(id)).toMatchObject({ archived: true, executing: false });
    } finally {
      await gw.core.bots.remove(id);
      await stream.close();
    }
  }, 15_000);
});
