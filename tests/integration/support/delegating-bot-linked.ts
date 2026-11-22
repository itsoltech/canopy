import { expect } from "bun:test";
import { nodeRef, qualifyId, splitId } from "@canopy/domain/computers";
import type { BotModel, BotTurn } from "../../../apps/gateway/src/bots/types.ts";
import { failAfterCommentary } from "./agent-report.ts";
import { eventually, failure, type TestGateway } from "./gateway.ts";

export async function checkLinkedDelegatingBot(
  a: TestGateway,
  b: TestGateway,
  bot: string,
  workspace: string,
  project: string,
  source: "routine" | "routine and private steer",
  status: "completed" | "failed",
  setModel: (model: BotModel) => void,
) {
  const aNode = a.core.computers!.hello().nodeId;
  const bNode = b.core.computers!.hello().nodeId;
  const route = (v: string) => qualifyId(v, bNode);
  const routineTitle = "Check pending repairs";
  let target = "";
  setModel(async (input) => {
    if (input.messages.at(-1)?.role === "tool") return { text: "Delegated", calls: [] };
    const message = input.messages.findLast((m) => m.role === "user")?.text ?? "";

    if (message === "Set up linked monitoring")
      return {
        text: "",
        calls: [
          {
            id: "routine",
            name: "create_routine",
            arguments: {
              title: routineTitle,
              instructions: "Check the remote project.",
              cron: "0 4 * * *",
              timezone: "UTC",
            },
          },
        ],
      };

    if (message === "Ask the running thread to inspect the logs")
      return {
        text: "",
        calls: [
          {
            id: "steer",
            name: "send_message",
            arguments: {
              thread_id: target,
              text: "Inspect the logs",
              delivery: "steer",
            },
          },
        ],
      };

    if (message.includes("Background routine:"))
      return {
        text: "",
        calls: [
          {
            id: "spawn",
            name: "start_thread",
            arguments: {
              project_id: route(project),
              workspace_id: route(workspace),
              provider: "codex",
              provider_instance: "native",
              title: "Linked monitoring",
              prompt: "Investigate the remote project.",
            },
          },
        ],
      };

    return { text: "Acknowledged", calls: [] };
  });
  const read = () => a.core.bots.run((s) => s.conversation(a.userId, bot));
  await a.api.sendBotMessage({ botId: bot, text: "Set up linked monitoring", clientRequestId: crypto.randomUUID() });
  const routine = (await eventually(read, (c) => c.routines.length === 1 && !c.working)).routines[0]!;
  b.worker.holdTurns = true;

  try {
    await a.core.linkedAgents.query("UPDATE bot_routines SET next_run_at=now() WHERE id=$1::uuid", [routine.id]);

    const [spawn] = await eventually(
      () =>
        a.core.linkedAgents.query<{ target_id: string; call_id: string; result: { turn_id: string } }>(
          "SELECT target_id,call_id,result FROM computer_agent_calls WHERE actor_id=$1::uuid AND source_routine_id=$2::uuid AND direction='outgoing' AND operation='spawn' AND result IS NOT NULL",
          [bot, routine.id],
        ),
      (rows) => rows.length === 1,
    );

    const threadId = spawn!.target_id;
    target = route(threadId);
    const turnId = splitId(spawn!.result.turn_id).id;
    expect(await eventually(async () => b.worker.started.has(turnId), Boolean)).toBe(true);
    const args = { text: "Which branch should I check?" };
    const request = { callId: crypto.randomUUID(), threadId, turnId, tool: "message_delegating_bot", args };
    const sent = await b.worker.callTool(request);
    expect(sent.isError).toBe(false);
    const response = JSON.parse(sent.resultJson);
    expect(response).toMatchObject({ bot_id: qualifyId(bot, aNode), delivery: "queue" });
    expect((await b.worker.callTool(request)).resultJson).toBe(sent.resultJson);

    const callback = await a.core.linkedAgents.query<BotTurn>("SELECT * FROM bot_turns WHERE id=$1::uuid", [
      splitId(response.turn_id).id,
    ]);

    expect(callback[0]?.routine_id).toBe(routine.id);
    expect(callback[0]?.input).toContain(args.text);

    // Replay after a lost linked response hits the same durable receipt at the bot's home.
    const actor = { id: threadId, kind: "thread" as const, hops: 2, name: "Linked monitoring" };
    const envelope = { watches: [spawn!.call_id], text: args.text };
    expect(await b.core.linkedAgents.call(aNode, request.tool, actor, request.callId, envelope)).toEqual(response);
    expect(
      await failure(
        b.core.linkedAgents.call(
          aNode,
          request.tool,
          { ...actor, id: crypto.randomUUID() },
          crypto.randomUUID(),
          envelope,
        ),
      ),
    ).toContain("No active delegation");

    const mixed = source === "routine and private steer";

    if (mixed) {
      await a.api.sendBotMessage({
        botId: bot,
        text: "Ask the running thread to inspect the logs",
        clientRequestId: crypto.randomUUID(),
      });
      expect(
        await eventually(
          async () =>
            (await b.core.linkedAgents.snapshot(threadId)).steers.some(
              (s) => s.status === "delivered" && s.turnId === turnId,
            ),
          Boolean,
        ),
      ).toBe(true);

      const blocked = await b.worker.callTool({
        ...request,
        callId: crypto.randomUUID(),
        args: { text: "Private question" },
      });

      expect(blocked.isError).toBe(true);
      expect(blocked.content).toContain("more than one bot conversation");
    }

    const outcome = {
      completed: "The repair is ready.",
      failed: "Turn failed: Check interrupted\n\nReading the repair log",
    };

    if (status === "failed")
      failAfterCommentary(b.worker, threadId, turnId, "Check interrupted", "Reading the repair log", "");
    else b.worker.finish(threadId, turnId, outcome.completed);

    const finals = await eventually(
      () =>
        a.core.linkedAgents.query<BotTurn>(
          "SELECT * FROM bot_turns WHERE bot_id=$1::uuid AND client_request_id LIKE $2 AND status='completed'",
          [bot, `report:${nodeRef(bNode)}:%:${turnId}`],
        ),
      (rows) => rows.length === (mixed ? 2 : 1),
    );

    expect(finals.map((t) => t.routine_id).sort()).toEqual((mixed ? [routine.id, null] : [routine.id]).sort());
    const message = mixed ? "The turn ended." : outcome[status];
    const report = `[canopy] thread ${target} on ${b.core.computers!.hello().name} ended: ${status}.\n${message}`;

    for (const turn of finals) {
      const instructions = turn.routine_id
        ? `Routine instructions (${routineTitle}):\nCheck the remote project.\n\n`
        : "";

      expect(turn.input).toBe(instructions + report);
    }

    const visible = (await read()).messages.map((m) => m.text).join("\n");

    for (const hidden of [args.text, "Private question", "Check interrupted", "Reading the repair log"])
      expect(visible).not.toContain(hidden);
    expect((await b.worker.callTool({ ...request, callId: crypto.randomUUID() })).isError).toBe(true);

    const followup = await b.api.sendMessage({
      threadId,
      text: "Check the private deployment",
      clientRequestId: crypto.randomUUID(),
    });

    const followupTurn = followup.turn!.id;
    expect(await eventually(async () => b.worker.started.has(followupTurn), Boolean)).toBe(true);
    const update = "The private deployment is ready.";

    const sentPrivately = await b.worker.callTool({
      ...request,
      turnId: followupTurn,
      callId: crypto.randomUUID(),
      args: { text: update },
    });

    expect(sentPrivately.isError, sentPrivately.content).toBe(false);
    const privateResponse = JSON.parse(sentPrivately.resultJson);
    expect(privateResponse).toMatchObject({ bot_id: qualifyId(bot, aNode), delivery: "queue" });

    const [privateCallback] = await eventually(
      () =>
        a.core.linkedAgents.query<BotTurn>("SELECT * FROM bot_turns WHERE id=$1::uuid", [
          splitId(privateResponse.turn_id).id,
        ]),
      (rows) => rows[0]?.status === "completed",
    );

    expect(privateCallback?.status).toBe("completed");
    expect(privateCallback?.routine_id).toBeNull();
    expect(privateCallback?.input).toContain(update);
    expect(
      await failure(
        b.core.linkedAgents.call(aNode, request.tool, { ...actor, id: crypto.randomUUID() }, crypto.randomUUID(), {
          spawn_id: spawn!.call_id,
          text: update,
        }),
      ),
    ).toContain("No active delegation");
    b.worker.finish(threadId, followupTurn, update);
    expect(
      await eventually(
        async () =>
          (await b.core.linkedAgents.snapshot(threadId)).turns.some(
            (t) => t.id === followupTurn && t.status === "completed",
          ),
        Boolean,
      ),
    ).toBe(true);
  } finally {
    b.worker.holdTurns = false;
    await a.api.deleteBotRoutine({ botId: bot, routineId: routine.id });
  }
}
