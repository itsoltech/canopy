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
  "official Codex calls Canopy MCP without native approval and returns the gateway result",
  async () => {
    const dir = temp("canopy-codex-tools-");
    const abort = new AbortController();
    const model = codexToolModel(["fixture_write"], "mcp__canopy");
    const { requests } = model;
    let calls = 0;

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
        record: async () => {},
        noteHarness: async () => {},
      });
      expect(requests.at(-1)).toContain("GATEWAY_APPROVAL_RESULT");
      expect(calls).toBe(1);
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
