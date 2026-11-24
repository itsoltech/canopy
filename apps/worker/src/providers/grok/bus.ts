import { agentBusToolsFor, type JsonValue } from "@canopy/domain";
import type { ThreadSpec } from "@canopy/contracts";
import { threadSecretOutputGuard } from "../../runtime/thread-secrets.ts";
import { platformMcp } from "../mcp-bus.ts";
import type { GrokThreads } from "./threads.ts";

export { platformMcp as grokBus, platformToolName, type PlatformMcpOptions as GrokBusOptions } from "../mcp-bus.ts";

interface ThreadCalls {
  turnId: string;
  toolUses: Map<string, { name: string; args: JsonValue }>;
}

export function grokThreadBus(
  options: GrokThreads["options"],
  spec: ThreadSpec,
  current: () => ThreadCalls | undefined,
) {
  const { redact } = threadSecretOutputGuard(spec.threadId);
  const viewImage = options.viewImage;

  return platformMcp({
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

      for (const [id, use] of entry?.toolUses ?? [])
        if (use.name === name && JSON.stringify(use.args) === JSON.stringify(args)) {
          entry?.toolUses.delete(id);

          return `${entry?.turnId}:${id}`;
        }

      return undefined;
    },
  });
}
