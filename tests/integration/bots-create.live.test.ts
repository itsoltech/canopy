import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, Provider } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { useLiveProxy } from "./support/live.ts";

const url = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const key = process.env["OA_LIVE_CLIPROXYAPI_KEY"];
const model = process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";
describe.skipIf(process.env["OA_LIVE"] !== "1" || !url || !key || !dockerAvailable)("bot creation through live CLIProxyAPI", () => {
  let gw: TestGateway;
  beforeAll(async () => {
    gw = await startTestGateway();
    await useLiveProxy(gw, gw.workerId, { url: url!, key: key!, allowedRoots: ["/repo"], harnesses: [Provider.CODEX] });
    await eventually(() => gw.core.bots.run((s) => s.apiModels(Provider.CODEX, "cliproxyapi")), (models) => models.some((m) => m.id === model));
    gw.core.bots.start();
  }, 30_000);
  afterAll(async () => { await gw?.core.bots.stop(); await gw?.close(); });

  test("a real bot proposes a haiku persona; after human approval the child answers in three lines", async () => {
    const name = `Haiku-${Bun.randomUUIDv7().slice(-6)}`;
    const parent = (await gw.api.createBot({ clientRequestId: Bun.randomUUIDv7(), configuration: {
      name: "Live creator", shape: "round", color: "#f97316", provider: Provider.CODEX, providerInstance: "cliproxyapi",
      model, effort: "low", approvalPolicy: "safe",
    } })).bot!;
    const read = (id: string) => gw.core.bots.run((s) => s.conversation(gw.userId, id));
    await gw.api.sendBotMessage({ botId: parent.id, clientRequestId: Bun.randomUUIDv7(), text: `Create a bot named ${name} that answers only in haiku. Put that behaviour in its standing instructions. Use your current provider instance, model and effort. Check list_models first, then propose create_bot. Do not message the new bot yet.` });
    const proposal = await eventually(() => read(parent.id), (s) => s.approvals.some((a) => a.status === "pending") || !s.working, 120_000);
    const card = proposal.approvals.find((a) => a.status === "pending")!;
    expect(card?.proposedBot?.name).toBe(name);
    expect(card.proposedBot?.instructions).toMatch(/haiku/i);
    expect((await gw.api.listBots({})).bots).toHaveLength(1);
    await gw.api.answerBotApproval({ approvalId: card.id, approve: true });
    await eventually(() => read(parent.id), (s) => !s.working, 120_000);
    const child = (await gw.api.listBots({})).bots.find((b) => b.configuration?.name === name)!;
    expect(child.createdByBotId).toBe(parent.id);
    expect((await read(child.id)).messages).toHaveLength(0);
    await gw.api.sendBotMessage({ botId: child.id, text: "Describe an autumn garden.", clientRequestId: Bun.randomUUIDv7() });
    const result = await eventually(() => read(child.id), (s) => !s.working, 120_000);
    expect(result.messages.at(-1)?.failed).toBe(false);
    const poem = result.messages.at(-1)!.text.trim();
    expect(poem.split(/\r?\n/).filter((line) => line.trim())).toHaveLength(3);
    console.info(`live create_bot: approval, owned child, empty initial conversation and haiku response verified.\n${poem}`);
  }, 360_000);
});
