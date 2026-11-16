import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolCall } from "./protocol.ts";

const browserArguments = z.object({
  namespace: z.string().optional(),
  headed: z.boolean().optional(),
  all: z.boolean().optional(),
  extraArgs: z.array(z.string()).optional(),
});

const headedTools = new Set(["agent_browser_open", "agent_browser_doctor"]);
const pinnedFlags = new Set(["--session", "--namespace", "--headed", "--all"]);

const POLICY_INSTRUCTIONS =
  "This is a hard Canopy boundary: this thread's browser session is fixed and headless. Do not bypass it through shell or CLI commands, CDP, another browser, or repeated override attempts. Tabs share this session's login state. If the task needs separate browser sessions for different users, explain this limitation to the user; separate Canopy threads are required.";

/** The browser and its preview must stay in the same thread session without opening an OS window. */
export function bindBrowserCall(params: z.infer<typeof ToolCall>): z.infer<typeof ToolCall> {
  const parsed = browserArguments.safeParse(params.arguments);

  if (!parsed.success) throw new Error("Invalid browser session or launch arguments");
  const args = parsed.data;

  if (args.namespace) throw new Error(`${POLICY_INSTRUCTIONS} Omit namespace and continue in this thread.`);

  if (args.headed) throw new Error(`${POLICY_INSTRUCTIONS} Omit headed and continue headless.`);

  if (args.all) throw new Error(`${POLICY_INSTRUCTIONS} Close only this thread's session; omit all.`);

  for (const argument of args.extraArgs ?? []) {
    if (pinnedFlags.has(argument.split("=", 1)[0] ?? ""))
      throw new Error(`${POLICY_INSTRUCTIONS} Remove session, namespace, headed and all flags from extraArgs.`);
  }

  const { headed: _headed, ...argumentsWithoutHeaded } = params.arguments;
  const bound = argumentsWithoutHeaded;

  // In 0.43 all tools accept shared extraArgs, but only open and doctor accept headed.
  // An environment false cannot override a headed:true CLI config; an explicit flag can.
  return {
    ...params,
    arguments: headedTools.has(params.name)
      ? { ...bound, headed: false }
      : { ...bound, extraArgs: [...(args.extraArgs ?? []), "--headed", "false"] },
  };
}

export function browserCatalog(tools: Tool[]): Tool[] {
  return tools.map((tool) => {
    const properties = { ...tool.inputSchema.properties };

    if (Object.hasOwn(properties, "headed"))
      properties["headed"] = {
        type: "boolean",
        enum: [false],
        default: false,
        description: "Browser Preview runs headless. Keep false or omit.",
      };

    if (Object.hasOwn(properties, "all"))
      properties["all"] = {
        type: "boolean",
        enum: [false],
        default: false,
        description: "Close only this thread's session. Keep false or omit.",
      };

    return {
      ...tool,
      description: `${tool.description ?? ""}\n${POLICY_INSTRUCTIONS} Omit session, namespace and headed launch flags.`,
      inputSchema: { ...tool.inputSchema, properties },
    };
  });
}
