import { expect, test } from "bun:test";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { create } from "@bufbuild/protobuf";
import { AgentToolResultSchema, ConnectorToolSchema } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { tempDirs } from "@canopy/testing";
import { join } from "node:path";
import { claudeBusServer } from "./bus.ts";
import { spawnClaude } from "./spawn.ts";
import { claudeConnectorRefresh } from "./connector-mcp.ts";
import { startFakeModel } from "../../import/fixtures/fake-model.ts";

const temp = tempDirs();
const executable = Bun.which("claude");

/** Real SDK and CLI inventory, with an isolated home and no inference or device credentials. */
test.skipIf(!executable)(
  "Claude replaces connector MCP tools in the same native query",
  async () => {
    const root = temp("canopy-claude-connector-refresh-");
    const input = new AsyncChannel<SDKUserMessage>();

    const tool = create(ConnectorToolSchema, {
      accountId: crypto.randomUUID(),
      connectorType: "custom",
      accountName: "fixture",
      name: "fixture_connector_read",
      remoteName: "read",
      description: "Read fixture",
      inputSchemaJson: '{"type":"object","properties":{}}',
      readOnly: true,
    });

    const servers = (tools: readonly (typeof tool)[]) => ({
      canopy: claudeBusServer({
        threadId: crypto.randomUUID(),
        depth: 0,
        agentBus: false,
        connectorTools: tools,
        turnId: () => "",
        toolUseId: () => undefined,
        callTool: async () => create(AgentToolResultSchema),
      }),
    });

    const model = startFakeModel();
    const abort = new AbortController();

    const q = query({
      prompt: input,
      options: {
        cwd: root,
        pathToClaudeCodeExecutable: executable!,
        spawnClaudeCodeProcess: spawnClaude,
        env: {
          PATH: process.env["PATH"],
          HOME: root,
          CLAUDE_CONFIG_DIR: join(root, "claude"),
          ANTHROPIC_BASE_URL: model.url,
          ANTHROPIC_API_KEY: "fixture",
        },
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: servers([]),
        abortController: abort,
      },
    });

    const consumed = (async () => {
      for await (const _message of q) {
        /* Control responses are handled by the SDK. */
      }
    })().catch(() => {});

    const refresh = claudeConnectorRefresh(q, [], servers);

    try {
      for (const attached of [false, true, false]) {
        await refresh(attached ? [tool] : []);
        const status = (await q.mcpServerStatus()).find((s) => s.name === "canopy");
        expect(status?.status).toBe("connected");
        expect(status?.tools?.some((t) => t.name === tool.name || t.name === `mcp__canopy__${tool.name}`)).toBe(
          attached,
        );
      }
    } finally {
      input.close();
      abort.abort();
      await consumed;
      await model.stop();
    }
  },
  30_000,
);
