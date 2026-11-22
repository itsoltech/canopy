import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { claudeConnectorRefresh } from "./connector-mcp.ts";
import type { ConnectorTool, ThreadSpec } from "@canopy/contracts";
import { automationMcp, automationMcpKey } from "../local-automation.ts";
import { CLAUDE_VIEW_IMAGE_TOOL, claudeBusServer, claudeBusToolNames } from "./bus.ts";
import { BUS_SERVER } from "./mapping.ts";
import { callKey } from "./session-io.ts";
import type { ClaudeThreadsOptions } from "./thread-types.ts";

/** Keeps the thread's local automation bridge aligned with each gateway-authorized turn snapshot. */
export function claudeSessionMcp(
  options: ClaudeThreadsOptions,
  spec: ThreadSpec,
  turnId: () => string,
  calls: Map<string, string[]>,
) {
  let enableMemory = spec.enableMemory;
  let automationKey = automationMcpKey(spec);
  let hasDelegatingBot = spec.enableAgentBus && spec.hasDelegatingBot;
  let automation = automationMcp(options, spec, turnId);

  const servers = (tools: readonly ConnectorTool[]) => ({
    [BUS_SERVER]: claudeBusServer({
      threadId: spec.threadId,
      depth: spec.depth,
      hasDelegatingBot,
      enableMemory,
      agentBus: spec.enableAgentBus,
      connectorTools: tools,
      turnId,
      toolUseId: (tool, args) => calls.get(callKey(tool, args))?.shift(),
      callTool: options.callTool,
      ...(options.viewImage && { viewImage: (path: string) => options.viewImage!(spec.threadId, spec.cwd, path) }),
    }),
    ...Object.fromEntries(
      (automation?.servers ?? []).map((server) => [
        server.name,
        { type: "http" as const, url: server.url, headers: server.headers, alwaysLoad: true },
      ]),
    ),
  });

  return {
    servers,
    allowedTools: [
      ...(spec.enableAgentBus ? claudeBusToolNames(spec.depth, hasDelegatingBot) : []),
      ...(options.viewImage ? [CLAUDE_VIEW_IMAGE_TOOL] : []),
      `mcp__${BUS_SERVER}__*`,
      ...["agent_browser", "agent_desktop", "agent_device"].map((name) => `mcp__${name}__*`),
    ],
    refreshFor(query: Query) {
      const refresh = claudeConnectorRefresh(
        query,
        spec.connectorTools,
        servers,
        automationKey,
        hasDelegatingBot,
        enableMemory,
      );

      return async (current: ThreadSpec) => {
        enableMemory = current.enableMemory;
        const next = automationMcpKey(current);
        hasDelegatingBot = current.enableAgentBus && current.hasDelegatingBot;

        if (automationKey !== next) {
          await automation?.close();
          automation = automationMcp(options, current, turnId);
          automationKey = next;
        }

        await refresh(current.connectorTools, automationKey, hasDelegatingBot, enableMemory);
      };
    },
    close: async () => {
      await automation?.close();
    },
  };
}
