import { homedir } from "node:os";
import type { Command } from "@canopy/contracts";
import type { GatewayLink } from "../gateway-link/index.ts";
import { CliRefused } from "../cli-tools/index.ts";

import { CommandError, type CommandOutput } from "./host-types.ts";
import { importedCopyCommand } from "./import-commands.ts";
import { readImportLibraryItem } from "../import/library-read.ts";
import { readImportSecret } from "../import/library-secret.ts";
import { readImportPage } from "../import/pages.ts";
import type { HostContext } from "./host-context.ts";
import { providerAccounts } from "./account-commands.ts";
import { ProviderLogins } from "./provider-logins.ts";
import { withProcessPriority } from "@canopy/process-governor";
import { revealInFileManager } from "./reveal.ts";
import { isFileCommand, runFileCommand } from "./file-commands.ts";
import { ThreadDiffs } from "../files/thread-diff.ts";
import { ThreadDirectories } from "../files/thread-directory.ts";
import { ThreadHighlights } from "../files/thread-highlight.ts";
import { ThreadFilesWatcher } from "../files/thread-watch.ts";
import { agentToolsCommand } from "./agent-tools-commands.ts";
import { updateTurnPermissions } from "./permission-commands.ts";
import { SkillInstallers } from "./skill-installers.ts";

export class CommandHandlers {
  readonly #logins: ProviderLogins;
  readonly #directories = new ThreadDirectories();
  readonly #diffs: ThreadDiffs;
  readonly #highlights = new ThreadHighlights();
  readonly #filesWatcher = new ThreadFilesWatcher();
  readonly #skillInstallers: SkillInstallers;
  constructor(readonly ctx: HostContext) {
    this.#logins = new ProviderLogins(ctx);
    this.#diffs = new ThreadDiffs(ctx.state.options.dataDir);
    this.#skillInstallers = new SkillInstallers(ctx.state.options.cliProbe?.home ?? homedir(), ctx.state.deviceHomes);
  }

  rebindFileWatch(threadId: string, cwd: string) {
    return this.#filesWatcher.closeThread(threadId, cwd);
  }

  closeDirectories(permanent = false) {
    this.#filesWatcher.close();
    this.#highlights.close();

    return Promise.all([this.#directories.close(), this.#diffs.close(), this.#skillInstallers.closeAll(permanent)]);
  }

  async closeThreadResources(threadId: string): Promise<void> {
    this.#highlights.closeThread(threadId);
    await Promise.all([
      this.#filesWatcher.closeThread(threadId),
      this.#directories.closeThread(threadId),
      this.#diffs.closeThread(threadId),
    ]);
  }

  #checkFileThread(kind: Command["kind"]): void {
    if (
      (kind.case === "listThreadDirectory" && !kind.value.release) ||
      kind.case === "getThreadFileHighlight" ||
      kind.case === "listThreadDiff" ||
      kind.case === "readThreadDiff" ||
      (kind.case === "watchThreadFiles" && !kind.value.release)
    ) {
      // Archive releases existing snapshots, but authorized read-only diff queries may reopen them.
      if (
        this.ctx.state.closedThreads.has(kind.value.threadId) &&
        kind.case !== "listThreadDiff" &&
        kind.case !== "readThreadDiff"
      )
        throw new CommandError(
          "THREAD_CLOSED",
          "This thread is archived or deleted. Unarchive or restore it to continue.",
          true,
        );

      if (this.ctx.state.unloadingThreads.has(kind.value.threadId))
        throw new CommandError(
          "THREAD_CLEANUP_PENDING",
          "This thread is still closing. Wait a moment, then try again.",
          false,
        );
    }
  }

  async #diff(kind: Extract<Command["kind"], { case: "listThreadDiff" | "readThreadDiff" }>): Promise<CommandOutput> {
    this.ctx.ops.checkCwd(kind.value.workspace);

    return kind.case === "listThreadDiff"
      ? { threadDiff: await this.#diffs.list(kind.value) }
      : { threadDiffPage: await this.#diffs.read(kind.value) };
  }

  async #skillInstaller(
    kind: Extract<Command["kind"], { case: "skillInstaller" }>,
    link?: GatewayLink,
  ): Promise<CommandOutput> {
    if (!link || link !== this.ctx.state.link || this.ctx.state.shuttingDown || this.ctx.state.closing)
      throw new CommandError("SKILL_INSTALLER_DISCONNECTED", "Reconnect the computer to use the installer.", false);

    return { skillInstaller: await this.#skillInstallers.execute(kind.value) };
  }

  async #exportThreadImage(kind: Extract<Command["kind"], { case: "exportThreadImage" }>): Promise<CommandOutput> {
    const { threadId, turnId } = kind.value;

    return {
      threadImageExport: await this.ctx.state.imageExports.execute(kind.value, {
        cwd: this.ctx.state.cwds.get(threadId) ?? "",
        attachments: this.ctx.state.files.threadDir(threadId),
        running: this.ctx.state.running.has(`${threadId}/${turnId}`),
      }),
    };
  }

  async execute(command: Command, link?: GatewayLink): Promise<CommandOutput> {
    const kind = command.kind;
    this.#checkFileThread(kind);

    if (kind.case === "skillInstaller") return this.#skillInstaller(kind, link);

    if (kind.case === "exportThreadImage") return this.#exportThreadImage(kind);

    if (kind.case === "listDirectory") return this.ctx.ops.listDirectory(kind.value.path);

    if (kind.case === "listThreadDirectory") {
      this.ctx.ops.checkCwd(kind.value.workspace);

      return { threadDirectory: await this.#directories.list(kind.value) };
    }

    if (kind.case === "listThreadDiff" || kind.case === "readThreadDiff") return this.#diff(kind);

    if (kind.case === "getThreadFileHighlight") {
      this.ctx.ops.checkCwd(kind.value.workspace);

      return { threadFileHighlight: await this.#highlights.read(kind.value) };
    }

    if (kind.case === "watchThreadFiles") {
      if (!kind.value.release) this.ctx.ops.checkCwd(kind.value.workspace);
      await this.#filesWatcher.watch(kind.value, (value) => this.ctx.ops.send({ case: "threadFilesUpdate", value }));

      return {};
    }

    if (isFileCommand(kind)) return runFileCommand(this.ctx, kind);

    if (kind.case === "getProviderAccounts")
      return {
        providerAccounts: await withProcessPriority(kind.value.refresh ? "user" : "background", () =>
          providerAccounts(this.ctx, kind.value),
        ),
      };

    if (kind.case === "listGitRefs") return this.ctx.ops.listGitRefs(kind);

    if (kind.case === "getThreadGitStatus") return this.ctx.ops.getThreadGitStatus(kind);

    if (kind.case === "pullThreadOrigin") return this.ctx.ops.pullThreadOrigin(kind);

    if (kind.case === "switchThreadBranch") return this.ctx.ops.switchThreadBranch(kind);

    if (kind.case === "readWorkspaceOrigin") return this.ctx.ops.readWorkspaceOrigin(kind);

    if (kind.case === "readGitPrContext") return this.ctx.ops.readGitPrContext(kind);

    if (kind.case === "initRepository") return this.ctx.ops.initRepository(kind);

    if (kind.case === "cloneRepository") return this.ctx.ops.cloneRepository(kind, command.commandId);

    if (kind.case === "cancelCloneRepository") return this.ctx.ops.cancelCloneRepository(kind.value.commandId);

    if (kind.case === "createWorktree") return this.ctx.ops.createWorktree(kind, command.commandId);

    if (kind.case === "renameWorktreeBranch") return this.ctx.ops.renameWorktreeBranch(kind);

    if (kind.case === "scanWorktrees") return this.ctx.ops.scanWorktrees(kind);

    if (kind.case === "failedWorktreeCleanup") return this.ctx.ops.failedWorktreeCleanup(kind, link);

    if (kind.case === "cleanupRemovedBranch") return this.ctx.ops.cleanupRemovedBranch(kind);

    if (kind.case === "removeWorktree") return this.ctx.ops.removeWorktree(kind, command.commandId);

    if (kind.case === "revealWorktree") return this.ctx.ops.revealWorktree(kind);

    if (kind.case === "revealPath") {
      this.ctx.ops.checkCwd(kind.value.path);
      await revealInFileManager(kind.value.path);

      return {};
    }

    if (kind.case === "scanImportSources")
      return { importScan: await this.ctx.state.imports.scan(kind.value.agentClis) };

    if (kind.case === "readImportSecret") return { importSecret: readImportSecret(this.ctx.state.imports, kind.value) };

    if (kind.case === "readImportLibraryItem")
      return { importLibraryContent: readImportLibraryItem(this.ctx.state.imports, kind.value) };

    if (kind.case === "previewLocalSkill") {
      if (!this.ctx.ops.previewLocalSkill || (link && link !== this.ctx.state.link))
        throw new CommandError(
          "LOCAL_SKILL_UNAVAILABLE",
          "The computer connection changed. Refresh and try again.",
          false,
        );

      return { localSkillPreview: this.ctx.ops.previewLocalSkill(kind.value) };
    }

    if (kind.case === "readImportPage") return { importPage: readImportPage(this.ctx.state.imports, kind.value) };

    if (kind.case === "adoptImportedSession" || kind.case === "removeImportedCopy")
      return importedCopyCommand(this.ctx, kind);

    if (kind.case === "installCli") {
      try {
        await this.ctx.state.cli.start(kind.value);
      } catch (error) {
        throw error instanceof CliRefused ? new CommandError(error.code, error.message, false) : error;
      }

      return {};
    }

    if (kind.case === "installAgentTool" || kind.case === "probeAgentTools" || kind.case === "runAgentTool")
      return agentToolsCommand(this.ctx, kind);

    if (kind.case === "unloadThread") return this.ctx.ops.unloadThread(kind);

    if (kind.case === "interruptBotTurn") return this.ctx.ops.interruptBotTurn(kind.value);

    if (kind.case === "interruptTurn") return this.ctx.ops.interruptTurn(kind);

    return this.#executeConfigured(command);
  }

  async #executeConfigured({ kind, commandId }: Command): Promise<CommandOutput> {
    const config = this.ctx.state.config;

    if (!config) throw new CommandError("WORKER_NOT_CONFIGURED", "the worker has no configuration yet", false);

    switch (kind.case) {
      case "runBotTurn":
        return this.ctx.ops.runBotTurn(kind.value, commandId);
      case "steerBotTurn":
        return this.ctx.ops.steerBotTurn(kind.value);
      case "botFile":
        return this.ctx.ops.botFile(kind.value);
      case "createThread":
        return this.ctx.ops.createThread(kind);
      case "rewindThread":
        return this.ctx.ops.rewindThread(kind.value);
      case "startTurn":
        return this.ctx.ops.startTurn(kind, commandId);
      case "steerTurn":
        return this.ctx.ops.steerTurn(kind, commandId);
      case "updateTurnPermissions":
        return updateTurnPermissions(this.ctx, kind.value);
      case "listModels":
        return this.ctx.ops.listModelsCommand(kind);
      case "generateText":
        return this.ctx.ops.generateText(kind, config, commandId);
      case "probeProviders":
        return this.ctx.ops.probeProviders();
      case "startLogin":
        return { login: await this.#logins.start(kind.value.provider, kind.value.profileId) };
      case "completeLogin":
        this.#logins.complete(kind.value);

        return {};
      case "logoutProvider":
        await this.#logins.logout(kind.value);

        return {};
      case "listMentionCatalog":
        return this.ctx.ops.listMentionCatalog(kind);
      case "searchFiles":
        return this.ctx.ops.searchFiles(kind);
      case "setGoal":
        return this.ctx.ops.setGoal(kind);
      case "stopTask":
        return this.ctx.ops.stopTask(kind);
      default:
        throw new CommandError("UNIMPLEMENTED", `${kind.case ?? "empty"} is not supported by this worker yet`, true);
    }
  }
}
