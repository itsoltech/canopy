import type { Command } from "@canopy/contracts";
import { CliRefused } from "../cli-tools/index.ts";

import { CommandError, type CommandOutput } from "./host-types.ts";
import { adoptImportedSession, removeImportedCopy } from "../import/adopt.ts";
import { readImportLibraryItem } from "../import/library-read.ts";
import { readImportSecret } from "../import/library-secret.ts";
import { readImportPage } from "../import/pages.ts";
import type { HostContext } from "./host-context.ts";
import { providerAccounts } from "./account-commands.ts";
import { withProcessPriority } from "@canopy/process-governor";

export class CommandHandlers {
  constructor(readonly ctx: HostContext) {}
  async execute(command: Command): Promise<CommandOutput> {
    const kind = command.kind;

    if (kind.case === "listDirectory") return this.ctx.ops.listDirectory(kind.value.path);

    if (kind.case === "getProviderAccounts")
      return {
        providerAccounts: await withProcessPriority(kind.value.refresh ? "user" : "background", () =>
          providerAccounts(this.ctx, kind.value),
        ),
      };

    if (kind.case === "listGitRefs") return this.ctx.ops.listGitRefs(kind);

    if (kind.case === "switchThreadBranch") return this.ctx.ops.switchThreadBranch(kind);

    if (kind.case === "readWorkspaceOrigin") return this.ctx.ops.readWorkspaceOrigin(kind);

    if (kind.case === "initRepository") return this.ctx.ops.initRepository(kind);

    if (kind.case === "cloneRepository") return this.ctx.ops.cloneRepository(kind);

    if (kind.case === "createWorktree") return this.ctx.ops.createWorktree(kind);

    if (kind.case === "renameWorktreeBranch") return this.ctx.ops.renameWorktreeBranch(kind);

    if (kind.case === "scanWorktrees") return this.ctx.ops.scanWorktrees(kind);

    if (kind.case === "removeWorktree") return this.ctx.ops.removeWorktree(kind, command.commandId);

    if (kind.case === "revealWorktree") return this.ctx.ops.revealWorktree(kind);

    if (kind.case === "scanImportSources")
      return { importScan: await this.ctx.state.imports.scan(kind.value.agentClis) };

    if (kind.case === "readImportSecret") return { importSecret: readImportSecret(this.ctx.state.imports, kind.value) };

    if (kind.case === "readImportLibraryItem")
      return { importLibraryContent: readImportLibraryItem(this.ctx.state.imports, kind.value) };

    if (kind.case === "readImportPage") return { importPage: readImportPage(this.ctx.state.imports, kind.value) };

    if (kind.case === "adoptImportedSession")
      return { importedSessionId: adoptImportedSession(this.ctx.state.imports, this.ctx.state, kind.value) };

    if (kind.case === "removeImportedCopy") {
      removeImportedCopy(this.ctx.state.imports, this.ctx.state, kind.value);

      return {};
    }

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
      case "runBotTurn":
        return this.ctx.ops.runBotTurn(kind.value, command.commandId);
      case "interruptBotTurn":
        return this.ctx.ops.interruptBotTurn(kind.value);
      case "createThread":
        return this.ctx.ops.createThread(kind);
      case "startTurn":
        return this.ctx.ops.startTurn(kind, command.commandId);
      case "steerTurn":
        return this.ctx.ops.steerTurn(kind, command.commandId);
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
