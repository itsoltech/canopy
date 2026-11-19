import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AgentToolResultSchema, ConnectorToolSchema, Provider, RunBotTurnSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { grokBus } from "../providers/grok/bus.ts";
import { resolveProfiles } from "../providers/profiles.ts";
import { runCodexBot } from "./codex.ts";
import { botSession } from "./session.ts";
import { codexToolModel } from "./fixtures/codex-model.ts";

const temp = tempDirs();

test.skipIf(!Bun.which("codex"))(
  "a Codex bot retries a dropped response after its MCP call with the same input and tool result",
  async () => {
    const dir = temp("canopy-codex-tools-");
    const abort = new AbortController();

    const dropped = new Response('data: {"type":"response.created","response":{"id":"cut"}}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });

    const model = codexToolModel(["fixture_write", dropped], "mcp__canopy");
    const { requests } = model;
    let calls = 0;
    const usage: bigint[] = [];

    const bus = grokBus({
      threadId: "fixture-bot",
      depth: 0,
      agentBus: false,
      connectorTools: [
        create(ConnectorToolSchema, {
          name: "fixture_write",
          description: "Change fixture state",
          inputSchemaJson: '{"type":"object"}',
        }),
      ],
      turnId: () => "fixture-turn",
      callTool: async (call) => {
        calls++;
        expect(call.toolName).toBe("fixture_write");

        return create(AgentToolResultSchema, {
          callId: call.callId,
          content: "GATEWAY_APPROVAL_RESULT",
          isError: false,
        });
      },
    });

    const input = create(RunBotTurnSchema, {
      botId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      provider: Provider.CODEX,
      model: "gpt-6.1-sol",
      instructions: "Use Canopy tools.",
      input: "Change fixture state",
      historyJson: "[]",
      tools: [{ name: "fixture_write", description: "Change fixture state", inputSchemaJson: '{"type":"object"}' }],
    });

    const profile = resolveProfiles([
      { kind: "cliproxyapi", id: "fixture", baseUrl: model.url, apiKey: "fixture", providers: ["codex"] },
    ]).find((p) => p.config.id === "fixture")!.resolved!;

    if (!("url" in bus.server)) throw new Error("Expected HTTP MCP");
    const timer = setTimeout(() => abort.abort(), 15_000);

    try {
      await runCodexBot({
        input,
        profile,
        executable: "codex",
        clientVersion: "test",
        signal: abort.signal,
        session: botSession(input, { dataDir: dir, sourceHome: dir, linkLogin: false }),
        mcp: { url: bus.server.url, headers: Object.fromEntries(bus.server.headers.map((h) => [h.name, h.value])) },
        record: async (event) => {
          if (event.body?.case === "usageUpdated" && event.body.value.usage?.scope === 1)
            usage.push(event.body.value.usage.inputTokens ?? 0n);
        },
        noteHarness: async () => {},
        content: async () => ({ text: input.input, images: [], documents: [] }),
      });
      expect(requests).toHaveLength(3);
      expect(requests[1]).toContain("GATEWAY_APPROVAL_RESULT");
      expect(requests[2]).toBe(requests[1]);
      expect(calls).toBe(1);
      expect(usage.at(-1)).toBe(2n);
      expect(requests.join("\n")).not.toContain("approval policy is never");
    } finally {
      clearTimeout(timer);
      abort.abort();
      bus.close();
      await model.stop();
    }
  },
  20_000,
);
