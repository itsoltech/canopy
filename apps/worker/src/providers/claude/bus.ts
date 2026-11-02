import { create } from "@bufbuild/protobuf";
import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { AgentToolCallSchema, type AgentToolCall, type AgentToolResult, type ConnectorTool } from "@open-agents/contracts";
import { agentBusToolSpecs, agentBusToolsFor, VIEW_IMAGE_TOOL, viewImageSpec } from "@open-agents/domain";
import { z } from "zod";
import type { ViewImageResult } from "../../images/index.ts";
import { toolCallId } from "../tool-call-id.ts";
import { BUS_SERVER } from "./mapping.ts";

/**
 * Agent bus tools for Claude: an in-process MCP server "openagents" (tools `mcp__openagents__<name>`),
 * built from the same definitions as Codex's dynamicTools (packages/domain). The worker only forwards
 * calls to the gateway (AgentToolCall), which authorizes and runs them (docs/agent-bus.md).
 * The same server carries view_image, which the worker runs itself (images/view-image.ts) and which every thread has.
 */

export interface ClaudeBusOptions {
  readonly connectorTools?: readonly ConnectorTool[];
  readonly threadId: string;
  readonly depth: number;
  /** Agent bus tools (ThreadSpec.enable_agent_bus); view_image is there either way when viewImage is set. */
  readonly agentBus: boolean;
  viewImage?(path: string): Promise<ViewImageResult>;
  /** Platform turn running now (the call's source turn). */
  turnId(): string;
  /** tool_use id of a call by tool name and arguments, from the streamed assistant message. */
  toolUseId(tool: string, args: unknown): string | undefined;
  callTool(call: AgentToolCall): Promise<AgentToolResult>;
}

/** Longer than the longest wait_threads (300 s): the gateway answers every call, a timeout would orphan it. */
const BUS_TIMEOUT_MS = 330_000;

export function claudeBusToolNames(depth: number): string[] {
  return agentBusToolsFor(depth).map((name) => `mcp__${BUS_SERVER}__${name}`);
}

export const CLAUDE_VIEW_IMAGE_TOOL = `mcp__${BUS_SERVER}__${VIEW_IMAGE_TOOL}`;

export function claudeBusServer(options: ClaudeBusOptions): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: BUS_SERVER,
    // Always in the prompt: deferred behind tool search, models do not find them (seen live).
    alwaysLoad: true,
    timeout: BUS_TIMEOUT_MS,
    tools: [
      ...(options.agentBus ? busTools(options) : []),
      ...(options.connectorTools ?? []).map((spec) => ({
        name: spec.name, description: spec.description,
        inputSchema: z.fromJSONSchema(JSON.parse(spec.inputSchemaJson)) as never,
        handler: async (args: Record<string, unknown>, extra: unknown) => {
          const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
          const id = typeof meta?.["claudecode/toolUseId"] === "string" ? meta["claudecode/toolUseId"] as string : options.toolUseId(spec.name, args) ?? crypto.randomUUID();
          const result = await options.callTool(create(AgentToolCallSchema, { callId: toolCallId(options.threadId, id),
            threadId: options.threadId, turnId: options.turnId(), itemId: id, toolName: spec.name,
            connectorAccountId: spec.accountId, argumentsJson: JSON.stringify(args) }));
          return { content: [{ type: "text" as const, text: result.content }], ...(result.isError && { isError: true }) };
        },
      })),
      ...(options.viewImage ? [viewImageTool(options.viewImage)] : []),
    ],
  });
}

function viewImageTool(view: (path: string) => Promise<ViewImageResult>) {
  const spec = viewImageSpec();
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: z.fromJSONSchema(spec.inputSchema as Parameters<typeof z.fromJSONSchema>[0]) as never,
    handler: async (args: Record<string, unknown>) => {
      const result = await view(typeof args["path"] === "string" ? args["path"] : "");
      if (!result.ok) return { content: [{ type: "text" as const, text: result.message }], isError: true };
      return {
        content: [
          { type: "image" as const, data: result.base64, mimeType: result.mimeType },
          { type: "text" as const, text: result.summary },
        ],
      };
    },
  };
}

function busTools(options: ClaudeBusOptions) {
  return agentBusToolSpecs(agentBusToolsFor(options.depth)).map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: z.fromJSONSchema(spec.inputSchema as Parameters<typeof z.fromJSONSchema>[0]) as never,
      handler: async (args: Record<string, unknown>, extra: unknown) => {
        const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
        const fromMeta = typeof meta?.["claudecode/toolUseId"] === "string" ? (meta["claudecode/toolUseId"] as string) : undefined;
        const useId = fromMeta ?? options.toolUseId(spec.name, args) ?? crypto.randomUUID();
        const result = await options.callTool(
          create(AgentToolCallSchema, {
            callId: toolCallId(options.threadId, useId),
            threadId: options.threadId,
            turnId: options.turnId(),
            itemId: useId,
            toolName: spec.name,
            argumentsJson: JSON.stringify(args),
          }),
        );
        return { content: [{ type: "text" as const, text: result.content }], ...(result.isError && { isError: true }) };
      },
    }));
}
