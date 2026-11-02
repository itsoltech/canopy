import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, ProfileModelsSchema, Provider } from "@open-agents/contracts";
import { anthropicRequest, apiModel, directModel, grokRequest, openaiRequest } from "./model.ts";
import { PLATFORM_TOOLS } from "./policy.ts";
import type { ModelInput } from "./types.ts";

test("both wire protocols send only function tools and carry durable tool results", () => {
  const input: ModelInput = { configuration: create(bots.BotConfigurationSchema, { model: "model" }), instructions: "hi", signal: new AbortController().signal,
    tools: PLATFORM_TOOLS, messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "", calls: [{ id: "call1", name: "list_projects", arguments: {} }] }, { role: "tool", text: "[]", callId: "call1" }] };
  expect(openaiRequest(input).tools.every((t) => t.type === "function")).toBe(true);
  expect(anthropicRequest(input).tools.every((t) => !Object.hasOwn(t, "type"))).toBe(true);
  expect(JSON.stringify(openaiRequest(input))).toContain("function_call_output");
  expect(JSON.stringify(anthropicRequest(input))).toContain("tool_result");
  expect(JSON.stringify(grokRequest(input))).toContain('"tool_call_id":"call1"');
  expect(grokRequest(input).tools.every((t) => t.type === "function")).toBe(true);
});

for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) test(`${Provider[provider]}: direct API receives no tools that execute ls, and never dispatches a hosted tool`, async () => {
  let captured: Record<string, unknown> = {};
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    captured = await request.json() as Record<string, unknown>;
    return Response.json(provider === Provider.CLAUDE
      ? { content: [{ type: "text", text: "I have no shell." }], stop_reason: "end_turn" }
      : provider === Provider.GROK ? { choices: [{ finish_reason: "stop", message: { content: "I have no shell." } }] }
      : { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "I have no shell." }] }] });
  } });
  try {
    const result = await directModel(async () => ({ url: server.url.toString(), key: "fixture" }))({
      configuration: create(bots.BotConfigurationSchema, { provider, model: "fixture", effort: "low" }),
      messages: [{ role: "user", text: "Run ls in your working directory" }], instructions: "No local tools", tools: PLATFORM_TOOLS, signal: new AbortController().signal,
    });
    expect(result.text).toContain("no shell");
    const raw = captured["tools"] as { name: string; type?: string; function?: { name: string } }[];
    const wire = raw.map((t) => ({ ...t, name: t.function?.name ?? t.name }));
    expect(wire.map((t) => t.name)).toEqual(PLATFORM_TOOLS.map((t) => t.name));
    expect(wire.some((t) => /shell|exec|patch|browser|web_search/.test(t.name))).toBe(false);
    expect(wire.some((t) => t.type && t.type !== "function")).toBe(false);
  } finally { await server.stop(true); }
});

test("harness aliases resolve to the concrete API model; unknown and unresolved ones are refused", () => {
  const catalog = create(ProfileModelsSchema, { provider: Provider.CLAUDE, profileId: "proxy", models: [
    { id: "default", resolvedModel: "claude-opus-5-5", isDefault: true }, { id: "opus", resolvedModel: "claude-opus-5-5" }, { id: "claude-sonnet-5-5" },
  ] });
  expect(apiModel("default", [catalog])).toEqual({ model: "claude-opus-5-5" });
  expect(apiModel("opus", [catalog])).toEqual({ model: "claude-opus-5-5" });
  expect(apiModel("claude-sonnet-5-5", [catalog])).toEqual({ model: "claude-sonnet-5-5" });
  expect(apiModel("claude-opus-5-5", [catalog])).toEqual({ model: "claude-opus-5-5" });
  expect(apiModel("sonnet", [catalog])).toHaveProperty("problem");
  expect(apiModel("default", [])).toHaveProperty("problem");
  expect(apiModel("claude-unknown", [catalog])).toHaveProperty("problem");
  // Custom ids of the instance and any id without a catalog are left to the endpoint.
  expect(apiModel("claude-unknown", [catalog], ["claude-unknown"])).toEqual({ model: "claude-unknown" });
  expect(apiModel("claude-unknown", [])).toEqual({ model: "claude-unknown" });
  expect(apiModel("claude-unknown", [create(ProfileModelsSchema, { ...catalog, detail: "proxy did not answer" })])).toEqual({ model: "claude-unknown" });
  expect(apiModel("", [catalog])).toHaveProperty("problem");
});
