import { create } from "@bufbuild/protobuf";
import {
  AgentToolCallSchema,
  ItemStatus,
  type AgentToolCall,
  type AgentToolResult,
  type ConnectorTool,
  type InputAttachment,
  type ThreadEvent,
} from "@canopy/contracts";
import type { ThreadEventInit } from "../journal/index.ts";
import {
  type AgentBusToolName,
  agentBusToolSpecs,
  agentBusToolsFor,
  PLATFORM_SERVER,
  viewImageSpec,
  VIEW_IMAGE_TOOL,
} from "@canopy/domain";
import type { ViewImageResult } from "../images/index.ts";
import type { McpToolsListed } from "../agent-tools-mcp/index.ts";
import type { McpServer } from "@canopy/acp";
import { threadMemoryTools } from "./memory-tools.ts";
import { toolCallId } from "./tool-call-id.ts";
import { Schema } from "effect";
import type { JsonValue } from "@canopy/domain";
import { decodeJsonObject, jsonObject, jsonString } from "./json.ts";
import { connectorNativeResult } from "./mcp-connector-result.ts";
import { threadSecretOutputGuard } from "../runtime/thread-secrets.ts";

const McpRequest = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
  params: Schema.optionalKey(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      arguments: Schema.optionalKey(Schema.Json),
      requestId: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
    }),
  ),
});

export interface PlatformMcp {
  server: Extract<McpServer, { type: "http" }>;
  close(): void;
}

export type McpAttachmentContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface McpAttachmentResult {
  content: McpAttachmentContent[];
  isError: boolean;
}

/** Stateless Streamable HTTP MCP bound to loopback, authenticated and scoped to a single thread. */
export interface PlatformMcpOptions {
  threadId: string;
  depth: number;
  agentBus?: false | readonly AgentBusToolName[];
  enableMemory?: boolean;
  toolsListed?: McpToolsListed;
  connectorTools?: readonly ConnectorTool[];
  record?(event: ThreadEventInit): Promise<ThreadEvent | void>;
  viewImage?(path: string): Promise<ViewImageResult>;
  toolUseId?(tool: string, args: JsonValue): string | undefined;
  turnId(): string;
  callTool(call: AgentToolCall, signal?: AbortSignal): Promise<AgentToolResult>;
  attachmentContent?(attachments: readonly InputAttachment[], signal: AbortSignal): Promise<McpAttachmentResult>;
}

export function platformMcp(options: PlatformMcpOptions): PlatformMcp {
  const token = crypto.randomUUID();
  const pending = new Map<string | number, AbortController>();

  const tools = () => [
    ...(options.agentBus === false ? [] : agentBusToolSpecs(options.agentBus ?? agentBusToolsFor(options.depth))),
    ...threadMemoryTools(options.enableMemory),
    ...(options.connectorTools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: decodeJsonObject(JSON.parse(t.inputSchemaJson)),
    })),
    ...(options.viewImage ? [viewImageSpec()] : []),
  ];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });

      if (request.method !== "POST") return new Response(null, { status: 405 });
      let rpc: typeof McpRequest.Type;

      try {
        rpc = Schema.decodeUnknownSync(McpRequest)(await request.json());
      } catch {
        return new Response(null, { status: 400 });
      }

      if (rpc.id === undefined) {
        if (rpc.method === "notifications/cancelled" && rpc.params?.requestId !== undefined)
          pending.get(rpc.params.requestId)?.abort();

        return new Response(null, { status: 202 });
      }

      const reply = (result: JsonValue | { tools: ReturnType<typeof tools> }) =>
        Response.json({ jsonrpc: "2.0", id: rpc.id, result });

      if (rpc.method === "initialize")
        return reply({
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "Canopy", version: "1" },
        });

      if (rpc.method === "ping") return reply({});

      if (rpc.method === "tools/list") {
        const catalog = tools();
        options.toolsListed?.(PLATFORM_SERVER, catalog);

        return reply({ tools: catalog });
      }

      if (rpc.method !== "tools/call" || !tools().some((t) => t.name === rpc.params?.name))
        return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Unknown tool" } });

      if (!options.turnId()) return reply({ content: [{ type: "text", text: "No active turn" }], isError: true });

      const abort = new AbortController();
      pending.set(rpc.id, abort);

      try {
        return await callTool(options, rpc, reply, AbortSignal.any([request.signal, abort.signal]));
      } finally {
        pending.delete(rpc.id);
      }
    },
    idleTimeout: 0,
  });

  return {
    server: {
      type: "http",
      name: PLATFORM_SERVER,
      url: `http://127.0.0.1:${server.port}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    },
    close: () => {
      void server.stop(true);
    },
  };
}

async function callTool(
  options: PlatformMcpOptions,
  rpc: typeof McpRequest.Type,
  reply: (result: JsonValue) => Response,
  signal: AbortSignal,
): Promise<Response> {
  const itemId = options.toolUseId?.(rpc.params!.name!, rpc.params?.arguments ?? {}) ?? crypto.randomUUID();
  const turnId = options.turnId();
  const argumentsJson = JSON.stringify(rpc.params?.arguments ?? {});
  const connector = options.connectorTools?.find((t) => t.name === rpc.params!.name);

  const record = (status: ItemStatus, resultJson = "", isError = false) =>
    options.record?.({
      turnId,
      body: {
        case: status === ItemStatus.IN_PROGRESS ? "itemStarted" : "itemCompleted",
        value: {
          item: {
            itemId,
            status,
            content: connector
              ? {
                  case: "toolCall",
                  value: {
                    name: connector.remoteName,
                    server: connector.accountName,
                    inputJson: argumentsJson,
                    output: resultJson,
                    isError,
                    connectorAccountId: connector.accountId,
                    connectorType: connector.connectorType,
                    connectorAccountName: connector.accountName,
                  },
                }
              : {
                  case: "agentBusCall",
                  value: { toolName: rpc.params!.name!, argumentsJson, resultJson, isError },
                },
          },
        },
      },
    });

  try {
    if (rpc.params?.name === VIEW_IMAGE_TOOL && options.viewImage) {
      const path = jsonString(jsonObject(rpc.params.arguments)?.["path"]);
      const image = await options.viewImage(path);

      const result = image.ok
        ? {
            content: [
              { type: "image", data: image.base64, mimeType: image.mimeType },
              { type: "text", text: image.summary },
            ],
          }
        : { content: [{ type: "text", text: image.message }], isError: true };

      await options.record?.({
        turnId,
        rawJson: JSON.stringify({ result }),
        body: {
          case: "itemCompleted",
          value: {
            item: {
              itemId,
              status: image.ok ? ItemStatus.COMPLETED : ItemStatus.FAILED,
              content: { case: "image", value: { path, source: VIEW_IMAGE_TOOL } },
            },
          },
        },
      });

      return reply(result);
    }

    await record(ItemStatus.IN_PROGRESS);

    const result = await options.callTool(
      create(AgentToolCallSchema, {
        callId: toolCallId(options.threadId, itemId),
        threadId: options.threadId,
        turnId,
        itemId,
        toolName: rpc.params!.name!,
        argumentsJson,
        connectorAccountId: connector?.accountId ?? "",
      }),
      signal,
    );

    const files =
      connector && !result.isError && result.attachments.length
        ? await options.attachmentContent?.(result.attachments, signal)
        : undefined;

    const isError = result.isError || (files?.isError ?? false);
    await record(isError ? ItemStatus.FAILED : ItemStatus.COMPLETED, result.content, isError);

    const native =
      connector && connectorNativeResult(result.resultJson, threadSecretOutputGuard(options.threadId).redact);

    return reply({
      content: [{ type: "text", text: result.content }, ...(native ? native.content : []), ...(files?.content ?? [])],
      ...(native && native.structuredContent && { structuredContent: native.structuredContent }),
      isError,
    });
  } catch {
    await record(ItemStatus.FAILED, "Platform tool failed", true);

    return reply({ content: [{ type: "text", text: "Platform tool failed" }], isError: true });
  }
}
