import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { AgentToolCallSchema, type AgentToolCall, type AgentToolResult, type ConnectorTool } from "@canopy/contracts";
import { agentBusToolSpecs, agentBusToolsFor, VIEW_IMAGE_TOOL, viewImageSpec, type ToolJsonSpec } from "@canopy/domain";
import { ListToolsRequestSchema, ToolSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ViewImageResult } from "../../images/index.ts";
import { toolCallId } from "../tool-call-id.ts";
import { threadMemoryTools } from "../memory-tools.ts";
import { BUS_SERVER } from "./mapping.ts";
import type { JsonValue } from "@canopy/domain";
import { Schema } from "effect";
import { decodeJsonObject, isString } from "../json.ts";
import { threadSecretOutputGuard } from "../../runtime/thread-secrets.ts";

const decodeExtra = Schema.decodeUnknownSync(
  Schema.Struct({ _meta: Schema.optionalKey(Schema.UndefinedOr(Schema.JsonObject)) }),
);

interface BusTool extends Omit<SdkMcpToolDefinition, "inputSchema"> {
  inputSchema: Tool["inputSchema"];
  argumentSchema: z.ZodType;
}

/**
 * Agent bus tools for Claude: an in-process MCP server "canopy" (tools `mcp__canopy__<name>`),
 * built from the same definitions as Codex's dynamicTools (packages/domain). The worker only forwards
 * calls to the gateway (AgentToolCall), which authorizes and runs them (docs/agent-bus.md).
 * The same server carries view_image, which the worker runs itself (images/view-image.ts) and which every thread has.
 */

export interface ClaudeBusOptions {
  readonly connectorTools?: readonly ConnectorTool[];
  readonly threadId: string;
  readonly depth: number;
  readonly enableMemory?: boolean;
  readonly hasDelegatingBot?: boolean;
  /** Agent bus tools (ThreadSpec.enable_agent_bus); view_image is there either way when viewImage is set. */
  readonly agentBus: boolean;
  viewImage?(path: string): Promise<ViewImageResult>;
  /** Platform turn running now (the call's source turn). */
  turnId(): string;
  /** tool_use id of a call by tool name and arguments, from the streamed assistant message. */
  toolUseId(tool: string, args: JsonValue): string | undefined;
  callTool(call: AgentToolCall, signal?: AbortSignal): Promise<AgentToolResult>;
}

/** Longer than the longest wait_threads (300 s): the gateway answers every call, a timeout would orphan it. */
export const BUS_TIMEOUT_MS = 330_000;

/** Image publication gets a longer deadline; the SDK only supports a server-wide bound. */
const IMAGE_PUBLICATION_TIMEOUT_MS = 15 * 60_000;

/** Cancel the durable gateway wait at the tool's deadline, within the SDK's server-wide bound. */
function timedCall(options: ClaudeBusOptions, call: AgentToolCall): Promise<AgentToolResult> {
  const timeout =
    call.toolName === "show_images" && !call.connectorAccountId ? IMAGE_PUBLICATION_TIMEOUT_MS : BUS_TIMEOUT_MS;

  const deadline = Date.now() + timeout;
  call.expiresAt = timestampFromDate(new Date(deadline));

  return options.callTool(call, AbortSignal.timeout(Math.max(0, deadline - Date.now())));
}

export function claudeBusToolNames(depth: number, hasDelegatingBot = false): string[] {
  return agentBusToolsFor(depth, hasDelegatingBot).map((name) => `mcp__${BUS_SERVER}__${name}`);
}

export const CLAUDE_VIEW_IMAGE_TOOL = `mcp__${BUS_SERVER}__${VIEW_IMAGE_TOOL}`;

export function claudeBusServer(options: ClaudeBusOptions): McpSdkServerConfigWithInstance {
  const tools = [
    ...busTools(options),
    ...(options.connectorTools ?? []).map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: ToolSchema.shape.inputSchema.parse(JSON.parse(spec.inputSchemaJson)),
      // The remote server validates its own arguments. Retain every field for approval and forwarding.
      argumentSchema: z.looseObject({}),
      handler: remoteToolHandler(options, spec.name, spec.accountId),
    })),
    ...(options.viewImage ? [viewImageTool(options.viewImage, threadSecretOutputGuard(options.threadId).redact)] : []),
  ];

  const server = createSdkMcpServer({
    name: BUS_SERVER,
    timeout: IMAGE_PUBLICATION_TIMEOUT_MS,
    tools: tools.map(({ name, description, argumentSchema, handler }) => ({
      name,
      description,
      // SAFETY: The SDK accepts a full Zod schema at runtime; its declaration only describes raw shapes.
      inputSchema: argumentSchema as never,
      handler,
    })),
  });

  // Advertise the source JSON Schemas directly so keywords such as if/then/else survive the SDK transport.
  server.instance.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
      // Always in the prompt: deferred behind tool search, models do not find them (seen live).
      _meta: { "anthropic/alwaysLoad": true },
    })),
  }));

  return server;
}

function platformTool(spec: ToolJsonSpec, handler: SdkMcpToolDefinition["handler"]): BusTool {
  const inputSchema = ToolSchema.shape.inputSchema.parse(spec.inputSchema);
  // SAFETY: Platform specs come from Canopy's JSON Schema generators.
  const argumentSchema = z.fromJSONSchema(spec.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);

  return { ...spec, inputSchema, argumentSchema, handler };
}

function viewImageTool(view: (path: string) => Promise<ViewImageResult>, redact: (text: string) => string): BusTool {
  return platformTool(viewImageSpec(), async (rawArgs) => {
    const args = decodeJsonObject(rawArgs);
    const result = await view(isString(args["path"]) ? args["path"] : "");

    if (!result.ok) return { content: [{ type: "text" as const, text: redact(result.message) }], isError: true };

    return {
      content: [
        { type: "image" as const, data: result.base64, mimeType: result.mimeType },
        { type: "text" as const, text: redact(result.summary) },
      ],
    };
  });
}

function busTools(options: ClaudeBusOptions): BusTool[] {
  return [
    ...(options.agentBus ? agentBusToolSpecs(agentBusToolsFor(options.depth, options.hasDelegatingBot)) : []),
    ...threadMemoryTools(options.enableMemory),
  ].map((spec) => platformTool(spec, remoteToolHandler(options, spec.name)));
}

function remoteToolHandler(
  options: ClaudeBusOptions,
  name: string,
  connectorAccountId = "",
): SdkMcpToolDefinition["handler"] {
  return async (rawArgs, extra) => {
    const args = decodeJsonObject(rawArgs);
    const id = decodeExtra(extra ?? {})._meta?.["claudecode/toolUseId"];
    const useId = isString(id) ? id : (options.toolUseId(name, args) ?? crypto.randomUUID());

    const result = await timedCall(
      options,
      create(AgentToolCallSchema, {
        callId: toolCallId(options.threadId, useId),
        threadId: options.threadId,
        turnId: options.turnId(),
        itemId: useId,
        toolName: name,
        connectorAccountId,
        argumentsJson: JSON.stringify(args),
      }),
    );

    return {
      content: [{ type: "text", text: threadSecretOutputGuard(options.threadId).redact(result.content) }],
      ...(result.isError && { isError: true }),
    };
  };
}
