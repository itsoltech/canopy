import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { bindSessionArguments, SESSION_INSTRUCTIONS, type AutomationCall } from "./session-policy.ts";

const batchSteps = z.array(z.object({ command: z.string(), input: z.record(z.string(), z.json()) }).catchall(z.json()));

const SCRIPT_INSTRUCTIONS =
  "Use replay for each script in this thread. Device test creates separate per-attempt sessions that Preview cannot follow and is unavailable in Canopy.";

/** A device opened by the agent must be visible to the same thread's Preview. */
export function bindDeviceCall(params: AutomationCall, session: string): AutomationCall {
  if (params.name === "test") throw new Error(`${SESSION_INSTRUCTIONS} ${SCRIPT_INSTRUCTIONS}`);

  if (params.name !== "batch") return params;

  return {
    ...params,
    arguments: {
      ...params.arguments,
      steps: batchSteps.parse(params.arguments["steps"]).map((step) => {
        if (step.command === "test") throw new Error(`${SESSION_INSTRUCTIONS} ${SCRIPT_INSTRUCTIONS}`);

        return { ...step, input: bindSessionArguments(step.input, session) };
      }),
    },
  };
}

export function deviceMcpCatalog(tools: Tool[]): Tool[] {
  return tools.flatMap((tool) => {
    if (tool.name === "test") return [];

    return [
      ["replay", "batch"].includes(tool.name)
        ? { ...tool, description: `${tool.description ?? ""}\n${SCRIPT_INSTRUCTIONS}` }
        : tool,
    ];
  });
}
