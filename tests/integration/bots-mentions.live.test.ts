import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MentionKind, Provider } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { useLiveProxy } from "./support/live.ts";

const url = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const key = process.env["OA_LIVE_CLIPROXYAPI_KEY"];

describe.skipIf(process.env["OA_LIVE"] !== "1" || !url || !key || !dockerAvailable)("bot mentions through live CLIProxyAPI", () => {
  let gw: TestGateway;
  beforeAll(async () => {
    gw = await startTestGateway();
    await useLiveProxy(gw, gw.workerId, { url: url!, key: key!, allowedRoots: ["/repo"], harnesses: [Provider.CODEX] });
    gw.core.bots.start();
  }, 30_000);
  afterAll(async () => { await gw?.close(); });

  test("ask @Kropek how he's doing uses the selected bot_id in send_bot_message", async () => {
    const add = async (name: string, instructions: string) => (await gw.api.createBot({ clientRequestId: Bun.randomUUIDv7(), configuration: {
      name, shape: "round", color: "#14b8a6", provider: Provider.CODEX, providerInstance: "cliproxyapi",
      model: process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol", effort: "low", approvalPolicy: "safe", instructions,
    } })).bot!;
    const target = await add("Kropek", "When asked how you are doing, reply briefly that you are doing well. Do not call any tools.");
    const author = await add("Canopy", "When asked to contact a mentioned bot, use send_bot_message exactly once. Use the mentioned bot_id. After the reply arrives, summarize it without sending again.");
    const text = "ask @Kropek how he's doing";
    await gw.api.sendBotMessage({ botId: author.id, text, clientRequestId: Bun.randomUUIDv7(), mentions: [
      { kind: MentionKind.BOT, name: target.id, label: "Kropek", start: 4, end: 11 },
    ] });
    const conversation = () => gw.core.bots.run((s) => s.conversation(gw.userId, author.id));
    const result = await eventually(conversation, (s) => !s.working && s.messages.some((m) => m.senderId === target.id && !!m.exchangeId), 120_000);
    expect(result.working).toBe(false);
    expect(result.messages.some((m) => m.senderId === target.id && !!m.exchangeId)).toBe(true);
    expect(result.messages[0]?.mentions[0]?.name).toBe(target.id);
    const calls = await gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ arguments: { bot_id: string }; status: string }>`SELECT c.arguments, c.status FROM bot_tool_calls c JOIN bot_turns t ON t.id = c.turn_id
        WHERE t.bot_id = ${author.id}::uuid AND c.tool ->> 'name' = 'send_bot_message'`;
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments.bot_id).toBe(target.id);
    expect(calls[0]?.status).toBe("completed");
  }, 150_000);
});
