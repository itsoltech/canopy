import { agentBusToolsFor, type JsonValue } from "@canopy/domain";
import { isDeepStrictEqual } from "node:util";
import type { ThreadSpec } from "@canopy/contracts";
import type { McpToolsListed } from "../../agent-tools-mcp/index.ts";
import { threadSecretOutputGuard } from "../../runtime/thread-secrets.ts";
import { platformMcp } from "../mcp-bus.ts";
import type { AcpThreadOptions } from "./thread-types.ts";

interface ThreadCalls {
  turnId: string;
  toolUses: Map<string, { name: string; args: JsonValue }>;
}

export function acpThreadBus(
  options: AcpThreadOptions,
  spec: ThreadSpec,
  current: () => ThreadCalls | undefined,
  toolsListed: McpToolsListed,
) {
  if (!spec.enableAgentBus && !spec.enableMemory && !spec.connectorTools.length && !options.viewImage) return undefined;
  const { redact } = threadSecretOutputGuard(spec.threadId);
  const viewImage = options.viewImage;

  return platformMcp({
    toolsListed,
    threadId: spec.threadId,
    depth: spec.depth,
    enableMemory: spec.enableMemory,
    agentBus: spec.enableAgentBus ? agentBusToolsFor(spec.depth, spec.hasDelegatingBot) : false,
    turnId: () => current()?.turnId ?? "",
    callTool: async (call, signal) => {
      const result = await options.callTool(call, signal);

      return { ...result, content: redact(result.content) };
    },
    connectorTools: spec.connectorTools,
    record: (event) => options.record(spec.threadId, event),
    ...(viewImage && {
      viewImage: async (path: string) => {
        const result = await viewImage(spec.threadId, spec.cwd, path);

        return result.ok
          ? { ...result, summary: redact(result.summary) }
          : { ...result, message: redact(result.message) };
      },
    }),
    toolUseId: (name, args) => {
      const entry = current();

      if (!entry?.turnId) return undefined;

      for (const [id, use] of entry.toolUses)
        if (use.name === name && isDeepStrictEqual(use.args, args)) {
          entry.toolUses.delete(id);

          return `${entry.turnId}:${id}`;
        }

      return undefined;
    },
  });
}
