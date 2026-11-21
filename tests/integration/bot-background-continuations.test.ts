import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BackgroundTaskKind, InteractionKind, ItemStatus, Provider, TurnOrigin, TurnOutcome } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { SqlClient } from "effect/sql";
import { MessengerStore } from "../../apps/gateway/src/messengers/store.ts";
import type { RoutineOrigin } from "../../apps/gateway/src/bots/routines.ts";
import { ClaudeEventMapper, startsTurn } from "../../apps/worker/src/providers/claude/mapping.ts";
import { botsSuite } from "./support/bots.ts";
import { eventually, type ScriptedWorker } from "./support/gateway.ts";

const frames = readFileSync(
  new URL("../../apps/worker/src/providers/claude/fixtures/background-bash-turn.jsonl", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Parameters<ClaudeEventMapper["map"]>[0]);

describe.skipIf(!dockerAvailable)("a bot watches its work in a persistent thread", () => {
  const { suite, add } = botsSuite();
  const botIds: string[] = [];
  let worker: ScriptedWorker;
  let workspaceId = "";

  const query = <T extends object>(text: string, values: string[]) =>
    suite.gw.runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<T>(text, values)));

  async function expectStatus(id: string, status: string) {
    const rows = await eventually(
      () => query<{ status: string }>("SELECT status FROM turns WHERE id=$1", [id]),
      (rows) => rows[0]?.status === status,
    );

    expect(rows).toEqual([{ status }]);
  }

  beforeAll(async () => {
    await suite.current.bots.stop();
    const machine = await suite.gw.addWorker("Claude", ["/repo"]);
    worker = await suite.gw.connect(machine.workerId, machine.credential, undefined, { claude: true });
    workspaceId = (
      await suite.gw.api.createWorkspace({
        projectId: suite.projectId,
        workerId: machine.workerId,
        rootPath: "/repo",
      })
    ).workspace!.id;
  });

  afterEach(async () => {
    worker.holdTurns = false;

    for (const id of botIds.splice(0)) await suite.current.bots.remove(id);
  });

  async function fixedThread() {
    worker.holdTurns = false;

    const thread = (
      await suite.gw.api.createThread({
        projectId: suite.projectId,
        workspaceId,
        provider: Provider.CLAUDE,
        title: "Persistent thread",
        initialMessage: "Earlier unrelated work",
      })
    ).thread!;

    const initial = await eventually(
      () => query<{ status: string }>("SELECT status FROM turns WHERE thread_id=$1", [thread.id]),
      (rows) => rows[0]?.status === "completed",
    );

    expect(initial).toEqual([{ status: "completed" }]);
    worker.holdTurns = true;

    return thread.id;
  }

  async function bot(name: string) {
    const result = await add(name);
    botIds.push(result.id);

    return result.id;
  }

  async function watch(thread: string, botId: string, origin: RoutineOrigin = {}) {
    const { bots } = suite.current;
    const owner = suite.gw.userId;

    await bots.run((s) => s.enqueue(owner, botId, "Run this", Bun.randomUUIDv7(), origin));
    const source = (await bots.run((s) => s.claim(owner)))!;
    expect(source.bot_id).toBe(botId);

    const call = await bots.run((s) =>
      s.planCall(
        source,
        "send",
        { name: "send_message", description: "", source: "platform", parameters: {} },
        {
          thread_id: thread,
          delivery: "queue",
          text: "Run the requested work",
        },
      ),
    );

    const sent = await suite.current.sendBotThreadMessage(source, call, thread, "Run the requested work", "queue");
    await bots.run((s) => s.finish(source, "completed", ""));
    await expectStatus(sent.turn_id, "running");

    return {
      turn: sent.turn_id,
      callId: call.id,
      reports: () =>
        query<{ input: string; bot_id: string; routine_id: string | null; conversation_id: string | null }>(
          "SELECT input,bot_id,routine_id,conversation_id FROM bot_turns WHERE client_request_id=$1",
          [`thread:${call.id}`],
        ),
    };
  }

  const deliver = (core = suite.current) => core.bots.run((s) => s.deliver(suite.gw.userId));

  function providerTurn(thread: string) {
    const id = Bun.randomUUIDv7();
    worker.emit(thread, id, { case: "turnStarted", value: { origin: TurnOrigin.PROVIDER } });

    return id;
  }

  function task(thread: string, turn: string, run: string, status = ItemStatus.IN_PROGRESS) {
    worker.emit(thread, status === ItemStatus.IN_PROGRESS ? turn : "", {
      case: status === ItemStatus.IN_PROGRESS ? "itemStarted" : "itemCompleted",
      value: {
        item: {
          itemId: `bg:${run}`,
          status,
          content: {
            case: "backgroundTask",
            value: {
              taskId: run,
              kind: BackgroundTaskKind.SHELL,
              startedInTurnId: turn,
              providerRunId: run,
              ...(status === ItemStatus.INTERRUPTED && { stopReason: "stopped_by_user" }),
            },
          },
        },
      },
    });
  }

  function result(thread: string, turn: string, text: string, run = "", outcome = TurnOutcome.COMPLETED) {
    worker.emit(thread, turn, {
      case: "itemCompleted",
      value: {
        item: {
          itemId: `answer:${turn}`,
          status: ItemStatus.COMPLETED,
          content: { case: "agentMessage", value: { text, phase: "final_answer" } },
        },
      },
    });
    worker.emit(thread, turn, { case: "turnFinished", value: { outcome, backgroundTaskRunId: run } });
  }

  test("Claude's own wake-ups keep one watch through a chain and finalize once after a gateway restart", async () => {
    const thread = await fixedThread();
    const id = await bot("Coordinator");
    const other = await bot("Other bot");
    const work = await watch(thread, id);

    const mapper = new ClaudeEventMapper(work.turn);
    const split = frames.findIndex((msg) => msg.type === "result") + 1;

    const play = (messages: typeof frames) => {
      for (const message of messages) {
        for (const event of mapper.map(message)) worker.emit(thread, event.turnId ?? "", event.body, event.rawJson);
      }
    };

    play(frames.slice(0, split));
    await expectStatus(work.turn, "completed");
    await deliver();
    expect(await work.reports()).toEqual([]);
    expect(await suite.current.bots.run((s) => s.poll(suite.gw.userId, new Date()))).toMatchObject({ ready: false });

    const wakeFrames = frames.slice(split);
    const start = wakeFrames.findIndex(startsTurn);
    play(wakeFrames.slice(0, start));
    const wake = providerTurn(thread);
    mapper.beginTurn(wake);
    await expectStatus(wake, "running");
    await deliver();
    expect(await work.reports()).toEqual([]);

    task(thread, wake, "second-task");
    play(wakeFrames.slice(start));
    await expectStatus(wake, "completed");
    await deliver();
    expect(await work.reports()).toEqual([]);

    task(thread, wake, "second-task", ItemStatus.COMPLETED);
    const last = providerTurn(thread);
    result(thread, last, "The second background task supplied the final result", "second-task");
    await expectStatus(last, "completed");

    const restarted = new GatewayCore({
      runtime: suite.gw.runtime,
      userId: suite.gw.userId,
      instanceId: Bun.randomUUIDv7(),
    });

    await Promise.all([deliver(restarted), deliver()]);
    // A late repeat with another event id cannot consume the same task for a second native turn.
    const repeated = providerTurn(thread);
    result(thread, repeated, "Must never be delivered", "second-task");
    await expectStatus(repeated, "completed");
    await deliver(restarted);
    await deliver();

    expect(await work.reports()).toEqual([
      {
        bot_id: id,
        routine_id: null,
        conversation_id: null,
        input: expect.stringContaining("The second background task supplied the final result"),
      },
    ]);
    expect(await query("SELECT id FROM bot_turns WHERE bot_id=$1", [other])).toEqual([]);
    expect(await query("SELECT id FROM turns WHERE id=$1 AND background_task_item_id IS NOT NULL", [repeated])).toEqual(
      [],
    );
  });

  test("a recurring routine keeps its own context and completes promptly without background work", async () => {
    const thread = await fixedThread();
    const id = await bot("Scheduled coordinator");
    const routine = Bun.randomUUIDv7();
    await query(
      `INSERT INTO bot_routines(id,bot_id,title,instructions,cron,timezone,schedule_text,hops,next_run_at)
        VALUES ($1,$2,'Check progress','Check progress','*/15 * * * *','UTC','Every 15 minutes',1,now()+interval '15 minutes')`,
      [routine, id],
    );
    const work = await watch(thread, id, { routineId: routine, routineTitle: "Check progress" });

    const schedule = await worker.callTool({
      threadId: thread,
      turnId: work.turn,
      tool: "schedule_recurring",
      args: { prompt: "Check again", cron: "0 * * * *", max_runs: 2 },
    });

    expect(schedule.isError).toBe(false);
    const requestId = Bun.randomUUIDv7();
    worker.ask({
      threadId: thread,
      turnId: work.turn,
      requestId,
      kind: InteractionKind.QUESTION,
      requestJson: '{"question":"Which milestone should I use?"}',
    });
    await eventually(
      () => query<{ status: string }>("SELECT status FROM interaction_requests WHERE id=$1", [requestId]),
      (rows) => rows[0]?.status === "pending",
    );
    await deliver();

    const questions = await query("SELECT routine_id FROM bot_turns WHERE client_request_id=$1", [
      `thread-question:${work.callId}:${requestId}`,
    ]);

    expect(questions).toEqual([{ routine_id: routine }]);
    expect(await work.reports()).toEqual([]);

    const permissionId = Bun.randomUUIDv7();
    worker.ask({
      threadId: thread,
      turnId: work.turn,
      requestId: permissionId,
      kind: InteractionKind.PERMISSION,
      toolName: "Bash",
      requestJson: '{"command":"true"}',
    });
    await eventually(
      () => query<{ status: string }>("SELECT status FROM interaction_requests WHERE id=$1", [permissionId]),
      (rows) => rows[0]?.status === "pending",
    );
    await suite.gw.api.answerInteraction({ requestId: permissionId, allow: false });

    const answer = await eventually(
      async () => worker.interactionAnswers.find((answer) => answer.requestId === permissionId),
      (answer) => answer?.allow === false,
    );

    expect(answer).toEqual({ requestId: permissionId, allow: false });
    await deliver();
    expect(
      await query("SELECT id FROM bot_turns WHERE client_request_id=$1", [
        `thread-question:${work.callId}:${permissionId}`,
      ]),
    ).toEqual([]);

    result(thread, work.turn, "Routine result");
    await expectStatus(work.turn, "completed");
    await deliver();
    expect(await work.reports()).toEqual([
      {
        bot_id: id,
        routine_id: routine,
        conversation_id: null,
        input: expect.stringContaining("Routine result"),
      },
    ]);
  });

  for (const revoke of [false, true]) {
    test(`a Claude follow-up respects a ${revoke ? "revoked" : "live"} Slack route`, async () => {
      const thread = await fixedThread();
      const botId = await bot("Slack coordinator");
      const { gw } = suite;

      const account = await gw.runtime.runPromise(
        MessengerStore.use((s) =>
          s.saveAccount(gw.userId, {
            name: "Test workspace",
            externalId: Bun.randomUUIDv7(),
            appToken: "xapp-fixture",
            botToken: "xoxb-fixture",
          }),
        ),
      );

      const route = await gw.runtime.runPromise(
        MessengerStore.use((s) =>
          s.saveRoute(gw.userId, {
            botId,
            accountId: account.id,
            channelIds: ["CPRODUCT"],
            userIds: ["UREPORTER"],
            directMessages: false,
            mentions: true,
            observe: false,
            delivery: "reply",
            instructions: "",
          }),
        ),
      );

      const original = Bun.randomUUIDv7();
      const different = Bun.randomUUIDv7();
      await query(
        `INSERT INTO bot_channel_conversations(id,route_id,channel_id,thread_id,open_until)
          VALUES ($1,$3,'CPRODUCT','100.1',now()),($2,$3,'CPRODUCT','200.1',now())`,
        [original, different, route.id],
      );
      const work = await watch(thread, botId, { conversationId: original });
      task(thread, work.turn, "external-task");
      result(thread, work.turn, "Foreground progress");
      await expectStatus(work.turn, "completed");
      await deliver();
      expect(await work.reports()).toEqual([]);

      if (revoke) await gw.runtime.runPromise(MessengerStore.use((s) => s.deleteRoute(gw.userId, route.id)));

      task(thread, work.turn, "external-task", ItemStatus.COMPLETED);
      const wake = providerTurn(thread);
      result(thread, wake, "The external task result", "external-task");
      await expectStatus(wake, "completed");
      await deliver();

      expect(await work.reports()).toEqual(
        revoke
          ? []
          : [
              {
                bot_id: botId,
                routine_id: null,
                conversation_id: original,
                input: expect.stringContaining("The external task result"),
              },
            ],
      );
    });
  }

  for (const ending of ["interrupted", "stopped", "timeout"] as const) {
    test(`a background watch settles once when ${ending}`, async () => {
      const thread = await fixedThread();
      const id = await bot("Coordinator");
      const work = await watch(thread, id);
      task(thread, work.turn, "pending-task");
      result(
        thread,
        work.turn,
        "Foreground result",
        "",
        ending === "interrupted" ? TurnOutcome.INTERRUPTED : TurnOutcome.COMPLETED,
      );
      await expectStatus(work.turn, ending === "interrupted" ? "interrupted" : "completed");
      await deliver();

      if (ending !== "interrupted") {
        expect(await work.reports()).toEqual([]);

        if (ending === "stopped") {
          task(thread, work.turn, "pending-task", ItemStatus.INTERRUPTED);
          await eventually(
            () =>
              query<{ status: string }>(
                "SELECT status FROM thread_items WHERE thread_id=$1 AND item_id='bg:pending-task'",
                [thread],
              ),
            (rows) => rows[0]?.status === "interrupted",
          );
        } else {
          await query("UPDATE turns SET completed_at=now()-interval '1 hour' WHERE id=$1", [work.turn]);
          await query("UPDATE bot_thread_watches SET continuation_check_at=now() WHERE call_id=$1", [work.callId]);
        }

        await deliver();
      }

      await deliver();
      const reports = await work.reports();
      expect(reports).toHaveLength(1);
      expect(reports[0]?.input).toContain(ending === "interrupted" ? "ended: interrupted" : "could not be confirmed");
    });
  }

  test("unrelated work in the same thread closes the watch without delivering its text or a later wake-up", async () => {
    const thread = await fixedThread();
    const id = await bot("Coordinator");
    const other = await bot("Other coordinator");
    const work = await watch(thread, id);
    task(thread, work.turn, "original-task");
    result(thread, work.turn, "Original progress");
    await expectStatus(work.turn, "completed");
    await deliver();
    expect(await work.reports()).toEqual([]);

    const unrelated = await watch(thread, other);
    result(thread, unrelated.turn, "Different bot's private result");
    await expectStatus(unrelated.turn, "completed");
    await deliver();

    task(thread, work.turn, "original-task", ItemStatus.COMPLETED);
    const wake = providerTurn(thread);
    result(thread, wake, "Wake-up after the conversation changed", "original-task");
    await expectStatus(wake, "completed");
    await deliver();

    const initial = await work.reports();
    expect(initial).toHaveLength(1);
    expect(initial[0]?.input).toContain("Original progress");
    expect(initial[0]?.input).not.toContain("private result");
    expect(initial[0]?.input).not.toContain("Wake-up");
    expect(await unrelated.reports()).toEqual([
      {
        bot_id: other,
        routine_id: null,
        conversation_id: null,
        input: expect.stringContaining("Different bot's private result"),
      },
    ]);
  });
});
