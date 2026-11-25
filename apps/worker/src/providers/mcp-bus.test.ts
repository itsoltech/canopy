import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AgentToolResultSchema, ConnectorToolSchema, InputAttachmentSchema, ItemStatus } from "@canopy/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult, type ImageContent } from "@modelcontextprotocol/sdk/types.js";
import type { ThreadEventInit } from "../journal/index.ts";
import { platformMcp, type PlatformMcpOptions } from "./mcp-bus.ts";

const connector = create(ConnectorToolSchema, {
  accountId: "fixture-account",
  accountName: "Fixture",
  connectorType: "custom",
  name: "fixture_preview",
  remoteName: "preview",
  inputSchemaJson: '{"type":"object"}',
});

const caption = { type: "text", text: "Synthetic preview" };

const image: ImageContent = {
  type: "image",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
};

const resultJson = JSON.stringify({ content: [caption, image] });

async function withPlatformMcp(
  options: Pick<PlatformMcpOptions, "callTool" | "record" | "attachmentContent">,
  run: (client: Client) => Promise<void>,
) {
  const bridge = platformMcp({
    threadId: "thread",
    turnId: () => "turn",
    depth: 0,
    agentBus: false,
    enableMemory: true,
    connectorTools: [connector],
    ...options,
  });

  const client = new Client({ name: "Canopy fixture", version: "1" });

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.server.url), {
        requestInit: { headers: Object.fromEntries(bridge.server.headers.map(({ name, value }) => [name, value])) },
      }),
    );
    await run(client);
  } finally {
    await client.close().finally(bridge.close);
  }
}

test("HTTP MCP delivers connector images alongside summary and attachments while recording only the summary", async () => {
  const events: ThreadEventInit[] = [];
  const content = JSON.stringify({ content: [caption] });
  const attachment = create(InputAttachmentSchema, { attachmentId: "notes", name: "notes.txt", kind: "file" });

  await withPlatformMcp(
    {
      callTool: async () => create(AgentToolResultSchema, { content, resultJson, attachments: [attachment] }),
      attachmentContent: async (attachments) => ({
        content: attachments.map(({ name }) => ({ type: "text", text: `Attachment ${name}` })),
        isError: false,
      }),
      record: async (event) => {
        events.push(event);
      },
    },
    async (client) => {
      const result = CallToolResultSchema.parse(await client.callTool({ name: connector.name }));
      const [summary, ...blocks] = result.content;

      expect(result.isError).toBe(false);
      expect(summary).toEqual({ type: "text", text: content });
      expect(blocks).toHaveLength(2);
      expect(blocks).toContainEqual(image);
      expect(blocks).toContainEqual({ type: "text", text: "Attachment notes.txt" });
      expect(events.at(-1)?.body).toMatchObject({
        case: "itemCompleted",
        value: {
          item: {
            status: ItemStatus.COMPLETED,
            content: { case: "toolCall", value: { connectorAccountId: connector.accountId, output: content } },
          },
        },
      });
      expect(JSON.stringify(events)).not.toContain(image.data);
    },
  );
});

test("HTTP MCP keeps legacy connector text and ignores structured images for platform tools", async () => {
  const content = "Plain tool output";

  await withPlatformMcp(
    {
      callTool: async (call) =>
        create(AgentToolResultSchema, { content, ...(call.toolName === "memory_search" && { resultJson }) }),
    },
    async (client) => {
      const expected = { content: [{ type: "text", text: content }], isError: false } satisfies CallToolResult;

      expect(await client.callTool({ name: connector.name })).toEqual(expected);
      expect(await client.callTool({ name: "memory_search", arguments: { queries: ["fixture"] } })).toEqual(expected);
    },
  );
});
