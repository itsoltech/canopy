import type { ConnectorTool, ThreadSpec } from "@canopy/contracts";
import { automationMcp } from "../local-automation.ts";
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
  let key = JSON.stringify(spec.localMcpTools);
  let automation = automationMcp(options, spec, turnId);

  return {
    get key() {
      return key;
    },
    allowedTools: [
      ...(spec.enableAgentBus ? claudeBusToolNames(spec.depth) : []),
      ...(options.viewImage ? [CLAUDE_VIEW_IMAGE_TOOL] : []),
      `mcp__${BUS_SERVER}__*`,
      ...["agent_browser", "agent_desktop", "agent_device"].map((name) => `mcp__${name}__*`),
    ],
    servers: (tools: readonly ConnectorTool[]) => ({
      [BUS_SERVER]: claudeBusServer({
        threadId: spec.threadId,
        depth: spec.depth,
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
    }),
    async refresh(current: ThreadSpec) {
      const next = JSON.stringify(current.localMcpTools);

      if (key === next) return;
      await automation?.close();
      automation = automationMcp(options, current, turnId);
      key = next;
    },
    close: async () => {
      await automation?.close();
    },
  };
}
