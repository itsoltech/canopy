import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, Provider } from "@canopy/contracts";
import { directModel } from "./model.ts";

const url = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const key = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];
test.skipIf(process.env["CANOPY_LIVE"] !== "1" || !url || !key)("cheap Grok bot API: function call and durable tool result through CLIProxyAPI", async () => {
  const run = directModel(async () => ({ url: url!, key: key! }));
  const input = {
    configuration: create(bots.BotConfigurationSchema, { provider: Provider.GROK, model: "grok-3-mini-fast", effort: "low" }),
    instructions: "Call list_projects once. After the result, answer only CANOPY_BOT_OK. Do not call any other tools.",
    tools: [{ name: "list_projects", source: "platform" as const, description: "List Canopy projects", parameters: { type: "object", properties: {} } }],
    signal: AbortSignal.timeout(45_000),
  };
  const messages = [{ role: "user" as const, text: "List my projects using the tool." }];
  const first = await run({ ...input, messages });
  expect(first.calls).toHaveLength(1); expect(first.calls[0]?.name).toBe("list_projects");
  const second = await run({ ...input, messages: [...messages, { role: "assistant", text: first.text, calls: first.calls }, { role: "tool", text: "[]", callId: first.calls[0]!.id }] });
  expect(second.text).toContain("CANOPY_BOT_OK"); expect(second.calls).toHaveLength(0);
}, 60_000);
