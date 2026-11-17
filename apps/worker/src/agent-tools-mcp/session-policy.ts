import { AgentTool, type AgentToolSessionDefaults } from "@canopy/contracts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolCall } from "./protocol.ts";

export type AutomationScope = Readonly<{ tool: AgentTool; session: string; defaults?: AgentToolSessionDefaults }>;

export type AutomationCall = z.infer<typeof ToolCall>;

const sessionArgument = z.object({ session: z.string().optional() });

export const SESSION_INSTRUCTIONS =
  "Automation and Preview share this thread's fixed session. Omit session to use it automatically. Do not create a separate session through shell or CLI commands.";

/** Validate before authorization; never silently redirect a call intended for a different session. */
export function bindSessionArguments(
  args: AutomationCall["arguments"],
  session: string,
  forward = true,
): AutomationCall["arguments"] {
  const parsed = sessionArgument.safeParse(args);

  if (!parsed.success) throw new Error("Invalid automation session argument");

  if (parsed.data.session && parsed.data.session !== session) throw new Error(SESSION_INSTRUCTIONS);
  const { session: _session, ...rest } = args;

  // Desktop forwards its fixed startup --session and does not accept a session MCP argument.
  return forward ? { ...rest, session } : rest;
}

export function sessionCatalog(tools: Tool[], scope: AutomationScope): Tool[] {
  return tools.map((tool) => {
    const properties = { ...tool.inputSchema.properties };

    if (Object.hasOwn(properties, "session"))
      properties["session"] = {
        type: "string",
        enum: [scope.session],
        description: `This thread's ${AgentTool[scope.tool].toLowerCase()} session. Omit to use it automatically.`,
      };

    return {
      ...tool,
      description: `${tool.description ?? ""}\n${SESSION_INSTRUCTIONS}`,
      inputSchema: { ...tool.inputSchema, properties },
    };
  });
}
