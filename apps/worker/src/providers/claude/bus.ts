import { create } from "@bufbuild/protobuf";
import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { AgentToolCallSchema, type AgentToolCall, type AgentToolResult } from "@open-agents/contracts";
import { agentBusToolSpecs, agentBusToolsFor } from "@open-agents/domain";
import { z } from "zod";
import { toolCallId } from "../tool-call-id.ts";
import { BUS_SERVER } from "./mapping.ts";

/**
 * Agent bus tools for Claude: an in-process MCP server "openagents" (tools `mcp__openagents__<name>`),
 * built from the same definitions as Codex's dynamicTools (packages/domain). The worker only forwards
 * calls to the gateway (AgentToolCall), which authorizes and runs them (docs/agent-bus.md).
 */

export interface ClaudeBusOptions {
  readonly threadId: string;
  readonly depth: number;
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

export function claudeBusServer(options: ClaudeBusOptions): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: BUS_SERVER,
    // Always in the prompt: deferred behind tool search, models do not find them (seen live).
    alwaysLoad: true,
    timeout: BUS_TIMEOUT_MS,
    tools: agentBusToolSpecs(agentBusToolsFor(options.depth)).map((spec) => ({
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
    })),
  });
}
