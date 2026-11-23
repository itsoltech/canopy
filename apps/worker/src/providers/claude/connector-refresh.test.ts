import { expect, test } from "bun:test";
import { query, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { create } from "@bufbuild/protobuf";
import { AgentToolResultSchema, ConnectorToolSchema, type AgentToolCall } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { tempDirs } from "@canopy/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import { claudeBusServer } from "./bus.ts";
import { spawnClaude } from "./spawn.ts";
import { claudeConnectorRefresh } from "./connector-mcp.ts";
import { userMessage } from "./session-io.ts";
import { startFakeModel } from "../../import/fixtures/fake-model.ts";
import { decodeJsonObject } from "../json.ts";

const temp = tempDirs();
const executable = Bun.which("claude");

const tool = create(ConnectorToolSchema, {
  accountId: crypto.randomUUID(),
  connectorType: "custom",
  accountName: "fixture",
  name: "fixture_connector_read",
  remoteName: "read",
  description: "Read fixture",
  inputSchemaJson: `{
    "type": "object",
    "properties": {
      "mode": { "type": "string", "enum": ["id", "text"] },
      "id": { "type": "string" },
      "text": { "type": "string" }
    },
    "required": ["mode"],
    "if": { "properties": { "mode": { "const": "id" } } },
    "then": { "required": ["id"] },
    "else": { "required": ["text"] }
  }`,
  readOnly: true,
});

const inputSchema = {
  ...decodeJsonObject(JSON.parse(tool.inputSchemaJson)),
  type: "object",
} satisfies Tool["inputSchema"];

test("Claude lists the original connector schema and forwards arguments and call identity", async () => {
  const calls: AgentToolCall[] = [];

  const server = claudeBusServer({
    threadId: "fixture-thread",
    depth: 0,
    agentBus: true,
    connectorTools: [tool],
    turnId: () => "fixture-turn",
    toolUseId: () => undefined,
    callTool: async (call) => {
      calls.push(call);

      return create(AgentToolResultSchema, { content: "fixture result" });
    },
  });

  const client = new Client({ name: "canopy-test", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  try {
    await server.instance.connect(serverSide);
    await client.connect(clientSide);
    const catalog = await client.listTools();
    const listed = catalog.tools.find(({ name }) => name === tool.name);

    expect(listed?.inputSchema).toEqual(inputSchema);
    expect(listed?._meta).toEqual({ "anthropic/alwaysLoad": true });
    expect(catalog.tools.some(({ name }) => name === "list_threads")).toBe(true);

    const args = { mode: "id", id: "fixture-id", extra: { locale: "en" } };

    const result = await client.callTool({
      name: tool.name,
      arguments: args,
      _meta: { "claudecode/toolUseId": "fixture-tool-use" },
    });

    expect(result.content).toEqual([{ type: "text", text: "fixture result" }]);
    expect(calls).toMatchObject([
      {
        toolName: tool.name,
        connectorAccountId: tool.accountId,
        turnId: "fixture-turn",
        itemId: "fixture-tool-use",
        argumentsJson: JSON.stringify(args),
      },
    ]);
  } finally {
    await client.close();
    await server.instance.close();
  }
});

/** Real SDK and CLI inventory, with an isolated home and no inference or device credentials. */
test.skipIf(!executable)(
  "Claude replaces connector MCP tools in the same native query",
  async () => {
    const root = temp("canopy-claude-connector-refresh-");
    const input = new AsyncChannel<SDKUserMessage>();

    let enableMemory = false;

    const servers = (tools: readonly (typeof tool)[]) => ({
      canopy: claudeBusServer({
        threadId: crypto.randomUUID(),
        depth: 0,
        agentBus: false,
        enableMemory,
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

    const result = Promise.withResolvers<SDKResultMessage | undefined>();

    const consumed = (async () => {
      for await (const message of q) {
        if (message.type === "result") result.resolve(message);
      }
    })()
      .catch(() => {})
      .finally(() => result.resolve(undefined));

    const refresh = claudeConnectorRefresh(q, [], servers);

    try {
      for (const [attached, memory] of [
        [false, true],
        [true, true],
        [true, false],
        [false, false],
      ] as const) {
        enableMemory = memory;
        await refresh(attached ? [tool] : [], "", false, memory);
        const status = (await q.mcpServerStatus()).find((s) => s.name === "canopy");
        expect(status?.status).toBe("connected");
        expect(status?.tools?.some((t) => t.name.endsWith("memory_search"))).toBe(memory);
        expect(status?.tools?.some((t) => t.name === tool.name || t.name === `mcp__canopy__${tool.name}`)).toBe(
          attached,
        );

        if (attached && memory) {
          input.push(userMessage("FIXTURE_CONNECTOR"));
          expect((await result.promise)?.subtype).toBe("success");

          const requests = model.requests.flatMap((request) =>
            request ? [decodeJsonObject(JSON.parse(request))] : [],
          );

          expect(requests).toContainEqual(
            expect.objectContaining({
              tools: expect.arrayContaining([
                expect.objectContaining({ name: `mcp__canopy__${tool.name}`, input_schema: inputSchema }),
              ]),
            }),
          );
        }
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
