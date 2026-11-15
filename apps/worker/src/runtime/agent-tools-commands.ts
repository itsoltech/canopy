import type { Command } from "@canopy/contracts";
import { AgentToolRefused } from "../agent-tools/index.ts";
import type { HostContext } from "./host-context.ts";
import { CommandError, type CommandOutput } from "./host-types.ts";

type AgentToolsCommand = Extract<Command["kind"], { case: "installAgentTool" | "probeAgentTools" | "runAgentTool" }>;

/** Transient local operations never enter the command journal or durable outbox. */
export async function agentToolsCommand(ctx: HostContext, command: AgentToolsCommand): Promise<CommandOutput> {
  try {
    if (command.case === "probeAgentTools") return { agentTools: await ctx.state.agentTools.probe() };

    if (command.case === "runAgentTool") return { agentTool: await ctx.state.agentTools.run(command.value) };
    await ctx.state.agentTools.install(command.value);

    return {};
  } catch (error) {
    if (error instanceof AgentToolRefused) throw new CommandError(error.code, error.message, false);
    throw error;
  }
}
