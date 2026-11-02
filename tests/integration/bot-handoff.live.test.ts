import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, Provider } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { useLiveProxy } from "./support/live.ts";

const url = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const key = process.env["OA_LIVE_CLIPROXYAPI_KEY"];

describe.skipIf(process.env["OA_LIVE"] !== "1" || !url || !key || !dockerAvailable)("live bot handoff through CLIProxyAPI", () => {
  let gw: TestGateway;
  beforeAll(async () => {
    gw = await startTestGateway();
    await useLiveProxy(gw, gw.workerId, { url: url!, key: key!, allowedRoots: ["/repo"], harnesses: [Provider.CODEX, Provider.GROK] });
    gw.core.bots.start();
  }, 30000);
  afterAll(async () => { await gw?.core.bots.stop(); await gw?.close(); });
  test("Codex hands a learned fact to Grok, which identifies its current model", async () => {
    const source = process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";
    const target = process.env["OA_LIVE_GROK_MODEL"] ?? "grok-3-mini-fast";
    for (const [harness, model] of [[Provider.CODEX, source], [Provider.GROK, target]] as const) await gw.api.setInstanceModels({ harness, id: "cliproxyapi", models: { custom: [model] } });
    const bot = (await gw.api.createBot({ clientRequestId: Bun.randomUUIDv7(), configuration: { name: "Live handoff", shape: "round", color: "#22aaff", provider: Provider.CODEX, providerInstance: "cliproxyapi", model: source, effort: "low", approvalPolicy: "safe", instructions: "Answer briefly. Do not use tools in this conversation." } })).bot!;
    const query = <A extends object>(text: string) => gw.runtime.runPromise(Effect.gen(function* () { return yield* (yield* SqlClient.SqlClient).unsafe<A>(text, [bot.id]); }));
    const conversation = () => gw.core.bots.run((s) => s.conversation(gw.userId, bot.id));
    const ask = async (text: string) => {
      await gw.core.bots.send(create(bots.SendBotMessageRequestSchema, { botId: bot.id, text, clientRequestId: Bun.randomUUIDv7() }));
      const result = await eventually(conversation, (s) => !s.working, 120000);
      expect(result.working).toBe(false); expect(result.messages.at(-1)?.failed).toBe(false); return result;
    };
    const fact = `FERN-${Bun.randomUUIDv7().slice(-8)}`;
    const learned = await ask(`Remember that my project codename is ${fact}. Confirm it and state your exact current model id.`);
    expect(learned.messages.at(-1)?.text).toContain(source);
    await gw.api.markBotRead({ botId: bot.id, throughSeq: learned.messages.at(-1)!.seq });
    await gw.api.updateBot({ botId: bot.id, configuration: { ...bot.configuration!, provider: Provider.GROK, model: target, effort: "low" } });
    const pending = await eventually(() => query("SELECT id FROM bot_turns WHERE bot_id = $1 AND handoff_configuration IS NOT NULL AND status IN ('queued','running')"), (rows) => rows.length === 0, 100000);
    expect(pending).toHaveLength(0);
    const notes = await query<{ model: string; note: string; fallback_reason: string }>("SELECT model, note, fallback_reason FROM bot_handoff_notes WHERE bot_id = $1");
    expect(notes).toHaveLength(1); expect(notes[0]?.model).toBe(source); expect(notes[0]?.fallback_reason).toBe(""); expect(notes[0]?.note).toContain(fact);
    const invisible = await conversation(); expect(invisible.messages).toEqual(learned.messages); expect(invisible.bot?.unreadCount).toBe(0);
    const final = await ask("What is my project codename, and which exact model id and provider are answering now?");
    expect(final.messages.at(-1)?.text).toContain(fact); expect(final.messages.at(-1)?.text).toContain(target);
    expect(final.messages.at(-1)?.text).toMatch(/Grok|xAI/i);
    console.info("live handoff: Codex note stored invisibly; Grok recalled the fact and identified its current model");
  }, 300000);
});
