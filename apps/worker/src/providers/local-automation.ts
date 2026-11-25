import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  AgentTool,
  AgentToolCallSchema,
  type AgentToolCall,
  type AgentToolResult,
  type ThreadSpec,
} from "@canopy/contracts";
import { createLocalAutomationMcp, type McpToolsListed } from "../agent-tools-mcp/index.ts";
import { toolEnvironment } from "../agent-tools/paths.ts";
import type { LocalAgentToolMcpServer } from "../agent-tools/index.ts";

export interface AutomationMcpOptions {
  localMcpServers?(
    tools: readonly AgentTool[],
    threadId: string,
    defaults?: ThreadSpec["agentToolDefaults"],
  ): readonly LocalAgentToolMcpServer[];
  /** An admitted automation call receives its live connection's one-way completion reporter. */
  callTool(
    call: AgentToolCall,
    signal?: AbortSignal,
    admitted?: (finish: () => void) => void,
  ): Promise<AgentToolResult>;
}

const toolIds = new Map([
  ["agent_browser", AgentTool.BROWSER],
  ["agent_desktop", AgentTool.DESKTOP],
  ["agent_device", AgentTool.DEVICE],
]);

/** One authenticated bridge per harness session. The subprocess never inherits provider credentials. */
export function automationMcp(
  options: AutomationMcpOptions,
  spec: ThreadSpec,
  turnId: () => string,
  toolsListed?: McpToolsListed,
) {
  const servers = options.localMcpServers?.(spec.localMcpTools, spec.threadId, spec.agentToolDefaults) ?? [];

  if (!servers.length) return undefined;

  return createLocalAutomationMcp({
    servers,
    ...(toolsListed && { toolsListed }),
    env: toolEnvironment(process.env),
    authorize: async (name, toolName, argsJson, signal) => {
      const tool = toolIds.get(name);
      const turn = turnId();

      if (!tool || !turn) throw new Error("Automation requires an active turn");
      const callId = Bun.randomUUIDv7();
      let finish: (() => void) | undefined;

      const result = await options.callTool(
        create(AgentToolCallSchema, {
          callId,
          threadId: spec.threadId,
          turnId: turn,
          itemId: callId,
          toolName: "authorize_local_automation",
          argumentsJson: JSON.stringify({ tool, name: toolName, arguments: argsJson }),
          expiresAt: timestampFromDate(new Date(Date.now() + 300_000)),
        }),
        signal,
        (complete) => {
          finish = complete;
        },
      );

      if (result.isError) throw new Error(result.content || "Automation access denied");

      if (turnId() !== turn) {
        finish?.();
        throw new Error("Automation turn ended during authorization");
      }

      return finish;
    },
  });
}

/** Defaults changes refresh the private bridge without resetting native sessions. */
export const automationMcpKey = (spec: ThreadSpec): string =>
  JSON.stringify([spec.localMcpTools, spec.agentToolDefaults]);
