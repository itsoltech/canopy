import type { Command } from "@canopy/contracts";
import { CliRefused } from "../cli-tools/index.ts";

import { CommandError, type CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

export class CommandHandlers {
  constructor(readonly ctx: HostContext) {}
  async execute(command: Command): Promise<CommandOutput> {
    const kind = command.kind;

    if (kind.case === "listDirectory") return this.ctx.ops.listDirectory(kind.value.path);

    if (kind.case === "installCli") {
      try {
        await this.ctx.state.cli.start(kind.value);
      } catch (error) {
        throw error instanceof CliRefused ? new CommandError(error.code, error.message, false) : error;
      }

      return {};
    }

    const config = this.ctx.state.config;

    if (!config) throw new CommandError("WORKER_NOT_CONFIGURED", "the worker has no configuration yet", false);

    switch (kind.case) {
      case "createThread":
        return this.ctx.ops.createThread(kind);
      case "startTurn":
        return this.ctx.ops.startTurn(kind);
      case "steerTurn":
        return this.ctx.ops.steerTurn(kind);
      case "listModels":
        return this.ctx.ops.listModelsCommand(kind);
      case "generateText":
        return this.ctx.ops.generateText(kind, config);
      case "probeProviders":
        return this.ctx.ops.probeProviders();
      case "startLogin":
        return this.ctx.ops.startLoginCommand(kind);
      case "listMentionCatalog":
        return this.ctx.ops.listMentionCatalog(kind);
      case "searchFiles":
        return this.ctx.ops.searchFiles(kind);
      case "interruptTurn":
        return this.ctx.ops.interruptTurn(kind);
      case "setGoal":
        return this.ctx.ops.setGoal(kind);
      case "stopTask":
        return this.ctx.ops.stopTask(kind);
      case "unloadThread":
        return this.ctx.ops.unloadThread(kind);
      default:
        throw new CommandError("UNIMPLEMENTED", `${kind.case ?? "empty"} is not supported by this worker yet`, true);
    }
  }
}
