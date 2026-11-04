import { create } from "@bufbuild/protobuf";
import {
  AgentToolCallSchema,
  ItemStatus,
  type AgentToolCall,
  type AgentToolResult,
  type ConnectorTool,
  type ThreadEvent,
} from "@canopy/contracts";
import type { ThreadEventInit } from "../../journal/index.ts";
import {
  agentBusToolSpecs,
  agentBusToolsFor,
  isPlatformServer,
  PLATFORM_SERVER,
  viewImageSpec,
  VIEW_IMAGE_TOOL,
} from "@canopy/domain";
import type { ViewImageResult } from "../../images/index.ts";
import type { McpServer } from "@canopy/grok-acp";
import { toolCallId } from "../tool-call-id.ts";
import { Schema } from "effect";
import type { JsonValue } from "@canopy/domain";
import { decodeJsonObject, jsonObject, jsonString } from "../json.ts";

const McpRequest = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.String,
  params: Schema.optionalKey(
    Schema.Struct({ name: Schema.optionalKey(Schema.String), arguments: Schema.optionalKey(Schema.Json) }),
  ),
});

interface GrokBus {
  server: McpServer;
  close(): void;
}

/** Stateless Streamable HTTP MCP bound to loopback, authenticated and scoped to a single thread. */
export function grokBus(options: {
  threadId: string;
  depth: number;
  agentBus?: boolean;
  connectorTools?: readonly ConnectorTool[];
  record?(event: ThreadEventInit): Promise<ThreadEvent | void>;
  viewImage?(path: string): Promise<ViewImageResult>;
  toolUseId?(tool: string, args: JsonValue): string | undefined;
  turnId(): string;
  callTool(call: AgentToolCall): Promise<AgentToolResult>;
}): GrokBus {
  const token = crypto.randomUUID();

  const tools = [
    ...(options.agentBus === false ? [] : agentBusToolSpecs(agentBusToolsFor(options.depth))),
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

      if (rpc.id === undefined) return new Response(null, { status: 202 });

      const reply = (result: JsonValue | { tools: typeof tools }) =>
        Response.json({ jsonrpc: "2.0", id: rpc.id, result });

      if (rpc.method === "initialize")
        return reply({
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "Canopy", version: "1" },
        });

      if (rpc.method === "ping") return reply({});

      if (rpc.method === "tools/list") return reply({ tools });

      if (rpc.method !== "tools/call" || !tools.some((t) => t.name === rpc.params?.name))
        return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Unknown tool" } });

      if (!options.turnId()) return reply({ content: [{ type: "text", text: "No active turn" }], isError: true });
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
        );

        await record(result.isError ? ItemStatus.FAILED : ItemStatus.COMPLETED, result.content, result.isError);

        return reply({ content: [{ type: "text", text: result.content }], isError: result.isError });
      } catch {
        await record(ItemStatus.FAILED, "Platform tool failed", true);

        return reply({ content: [{ type: "text", text: "Platform tool failed" }], isError: true });
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

/** Grok's name of a platform tool, `canopy__list_threads` → `list_threads`. */
export function platformToolName(name: string): string | undefined {
  const match = /^(.+?)__(.+)$/.exec(name);

  return match && isPlatformServer(match[1]) ? match[2] : undefined;
}
