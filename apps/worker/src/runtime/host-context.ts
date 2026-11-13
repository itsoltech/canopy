import { HostState } from "./host-state.ts";
import type { ConfigAppliedInit } from "./host-types.ts";
import type { WorkerConfig, ThreadEvent } from "@canopy/contracts";
import type { GatewayLink } from "../gateway-link/index.ts";
import { HostCatalog } from "./host-catalog.ts";
import { HostFiles } from "./host-files.ts";
import { CodexRuntimes } from "./codex-runtimes.ts";
import { ClaudeRuntimes } from "./claude-runtimes.ts";
import { ProviderRuntimes } from "./provider-runtimes.ts";
import { HostEvents } from "./host-events.ts";
import { ThreadCommands } from "./thread-commands.ts";
import { QueryCommands } from "./query-commands.ts";
import { TaskCommands } from "./task-commands.ts";
import { TextGeneration } from "./text-generation.ts";
import { CommandHandlers } from "./command-handlers.ts";
import { GitCommands } from "./git-commands.ts";
import { CloneCommands } from "./clone-commands.ts";
import { BranchCommands } from "./branch-commands.ts";
import { BotTurns } from "../bots/runtime.ts";

export interface HostHooks {
  applyConfig(message: WorkerConfig): Promise<ConfigAppliedInit>;
  sendPreviews(link: GatewayLink, event: ThreadEvent): void;
}

export type HostOperations = HostHooks &
  Pick<BranchCommands, "switchThreadBranch"> &
  Pick<HostCatalog, "homes" | "probe" | "startLogin" | "publishCatalog" | "listModels"> &
  Pick<HostFiles, "checkCwd" | "listDirectory" | "ensureAttachments" | "fetchBlob" | "viewImage"> &
  Pick<
    CodexRuntimes,
    | "runCodex"
    | "codexGroupOf"
    | "codexGroupWith"
    | "restartFailedCodex"
    | "codexGroups"
    | "startCodex"
    | "stopCodex"
    | "closeCodexOrphans"
  > &
  Pick<ClaudeRuntimes, "runClaude" | "startClaude" | "stopClaude"> &
  Pick<
    ProviderRuntimes,
    | "runGrok"
    | "startGrok"
    | "useRuntime"
    | "wakeRuntimes"
    | "runIn"
    | "reconcileRuntimes"
    | "stopReason"
    | "closeOrphans"
  > &
  Pick<HostEvents, "publish" | "sendEvent" | "interact" | "callTool" | "send" | "log"> &
  Pick<ThreadCommands, "createThread" | "startTurn" | "steerTurn" | "interruptTurn"> &
  Pick<
    QueryCommands,
    "listModelsCommand" | "probeProviders" | "startLoginCommand" | "listMentionCatalog" | "searchFiles"
  > &
  Pick<TaskCommands, "setGoal" | "stopTask" | "unloadThread"> &
  Pick<TextGeneration, "generateText"> &
  Pick<BotTurns, "runBotTurn" | "interruptBotTurn" | "closeBots" | "botFile"> &
  Pick<CloneCommands, "cloneRepository" | "cancelCloneRepository" | "closeClones"> &
  Pick<
    GitCommands,
    | "readWorkspaceOrigin"
    | "readGitPrContext"
    | "initRepository"
    | "listGitRefs"
    | "createWorktree"
    | "renameWorktreeBranch"
    | "scanWorktrees"
    | "removeWorktree"
    | "revealWorktree"
  > &
  Pick<CommandHandlers, "execute">;

export class HostContext {
  readonly ops: HostOperations;
  constructor(
    readonly state: HostState,
    hooks: HostHooks,
  ) {
    const catalog = new HostCatalog(this);
    const files = new HostFiles(this);
    const codex = new CodexRuntimes(this);
    const claude = new ClaudeRuntimes(this);
    const runtimes = new ProviderRuntimes(this);
    const events = new HostEvents(this);
    const threads = new ThreadCommands(this);
    const queries = new QueryCommands(this);
    const tasks = new TaskCommands(this);
    const generation = new TextGeneration(this);
    const bots = new BotTurns(this);
    const commands = new CommandHandlers(this);
    const gitCommands = new GitCommands(this);
    const clones = new CloneCommands(this);
    const branches = new BranchCommands(this);
    this.ops = {
      ...hooks,
      switchThreadBranch: branches.switchThreadBranch.bind(branches),
      homes: catalog.homes.bind(catalog),
      probe: catalog.probe.bind(catalog),
      startLogin: catalog.startLogin.bind(catalog),
      publishCatalog: catalog.publishCatalog.bind(catalog),
      listModels: catalog.listModels.bind(catalog),
      checkCwd: files.checkCwd.bind(files),
      listDirectory: files.listDirectory.bind(files),
      ensureAttachments: files.ensureAttachments.bind(files),
      fetchBlob: files.fetchBlob.bind(files),
      viewImage: files.viewImage.bind(files),
      runCodex: codex.runCodex.bind(codex),
      codexGroupOf: codex.codexGroupOf.bind(codex),
      codexGroupWith: codex.codexGroupWith.bind(codex),
      restartFailedCodex: codex.restartFailedCodex.bind(codex),
      codexGroups: codex.codexGroups.bind(codex),
      startCodex: codex.startCodex.bind(codex),
      stopCodex: codex.stopCodex.bind(codex),
      closeCodexOrphans: codex.closeCodexOrphans.bind(codex),
      runClaude: claude.runClaude.bind(claude),
      startClaude: claude.startClaude.bind(claude),
      stopClaude: claude.stopClaude.bind(claude),
      runGrok: runtimes.runGrok.bind(runtimes),
      startGrok: runtimes.startGrok.bind(runtimes),
      useRuntime: runtimes.useRuntime.bind(runtimes),
      wakeRuntimes: runtimes.wakeRuntimes.bind(runtimes),
      runIn: runtimes.runIn.bind(runtimes),
      reconcileRuntimes: runtimes.reconcileRuntimes.bind(runtimes),
      stopReason: runtimes.stopReason.bind(runtimes),
      closeOrphans: runtimes.closeOrphans.bind(runtimes),
      publish: events.publish.bind(events),
      sendEvent: events.sendEvent.bind(events),
      interact: events.interact.bind(events),
      callTool: events.callTool.bind(events),
      send: events.send.bind(events),
      log: events.log.bind(events),
      createThread: threads.createThread.bind(threads),
      startTurn: threads.startTurn.bind(threads),
      steerTurn: threads.steerTurn.bind(threads),
      interruptTurn: threads.interruptTurn.bind(threads),
      listModelsCommand: queries.listModelsCommand.bind(queries),
      probeProviders: queries.probeProviders.bind(queries),
      startLoginCommand: queries.startLoginCommand.bind(queries),
      listMentionCatalog: queries.listMentionCatalog.bind(queries),
      searchFiles: queries.searchFiles.bind(queries),
      setGoal: tasks.setGoal.bind(tasks),
      stopTask: tasks.stopTask.bind(tasks),
      unloadThread: tasks.unloadThread.bind(tasks),
      generateText: generation.generateText.bind(generation),
      runBotTurn: bots.runBotTurn.bind(bots),
      botFile: bots.botFile.bind(bots),
      interruptBotTurn: bots.interruptBotTurn.bind(bots),
      closeBots: bots.closeBots.bind(bots),
      execute: commands.execute.bind(commands),
      listGitRefs: gitCommands.listGitRefs.bind(gitCommands),
      readWorkspaceOrigin: gitCommands.readWorkspaceOrigin.bind(gitCommands),
      readGitPrContext: gitCommands.readGitPrContext.bind(gitCommands),
      initRepository: gitCommands.initRepository.bind(gitCommands),
      cloneRepository: clones.cloneRepository.bind(clones),
      cancelCloneRepository: clones.cancelCloneRepository.bind(clones),
      closeClones: clones.closeClones.bind(clones),
      createWorktree: gitCommands.createWorktree.bind(gitCommands),
      renameWorktreeBranch: gitCommands.renameWorktreeBranch.bind(gitCommands),
      scanWorktrees: gitCommands.scanWorktrees.bind(gitCommands),
      removeWorktree: gitCommands.removeWorktree.bind(gitCommands),
      revealWorktree: gitCommands.revealWorktree.bind(gitCommands),
    };
  }
}
