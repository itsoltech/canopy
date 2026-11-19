import { expect } from "bun:test";
import { qualifyId, splitId } from "@canopy/domain/computers";
import type { BotModel, BotTurn } from "../../../apps/gateway/src/bots/types.ts";
import { eventually, failure, type TestGateway } from "./gateway.ts";

export async function checkLinkedDelegatingBot(
  a: TestGateway,
  b: TestGateway,
  bot: string,
  workspace: string,
  project: string,
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

    // A private steer from the same bot entered a routine turn. Neither conversation may receive this text.
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

    const mixed = await b.worker.callTool({
      ...request,
      callId: crypto.randomUUID(),
      args: { text: "Private question" },
    });

    expect(mixed.isError).toBe(true);
    expect(mixed.content).toContain("more than one bot conversation");
    b.worker.finish(threadId, turnId, "The repair is ready.");

    const finals = await eventually(
      () =>
        a.core.linkedAgents.query<BotTurn>(
          "SELECT * FROM bot_turns WHERE bot_id=$1::uuid AND client_request_id LIKE 'report:%' AND status='completed'",
          [bot],
        ),
      (rows) => rows.length === 2,
    );

    expect(finals.map((t) => t.routine_id)).toContain(routine.id);
    expect(finals[0]?.input).toContain("The repair is ready.");
    expect((await read()).messages.some((m) => m.text.includes(args.text) || m.text.includes("Private question"))).toBe(
      false,
    );
    expect((await b.worker.callTool({ ...request, callId: crypto.randomUUID() })).isError).toBe(true);
  } finally {
    b.worker.holdTurns = false;
    await a.api.deleteBotRoutine({ botId: bot, routineId: routine.id });
  }
}
