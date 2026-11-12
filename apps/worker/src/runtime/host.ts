import { ThreadSecretFiles } from "./thread-secrets.ts";
import {
  Provider,
  type AgentToolResult,
  type BlobChunk,
  type Command,
  type InteractionResponse,
  type ThreadEvent,
  type WorkerConfig,
} from "@canopy/contracts";
import { applyWorkerConfig, type AppliedConfig, prepareSystemProbe } from "../config/remote.ts";
import type { GatewayLink } from "../gateway-link/index.ts";
import { Journal } from "../journal/index.ts";
import { reconcileTurn, WORKER_RESTARTED } from "../providers/reconcile.ts";
import { CliTools } from "../cli-tools/index.ts";
import { systemCliProbe } from "../cli-tools/discovery.ts";
import { installKind } from "@canopy/updater";
import { AttachmentError } from "../attachments/files.ts";
import { WorkerAgentEnvironment } from "../agent-environment/index.ts";

import {
  CommandError,
  commandProvider,
  type CommandResultInit,
  type ConfigAppliedInit,
  type WorkerHostOptions,
} from "./host-types.ts";
import { HostState } from "./host-state.ts";
import { HostContext } from "./host-context.ts";
import { HeadTracker } from "../git/heads.ts";
import { recoverShellInputs } from "./shell-input.ts";
import { UpdateCheckTimer } from "@canopy/domain/update-checks";
import { WorkspaceCopies } from "../workspace-copy/index.ts";

export type { WorkerHostOptions } from "./host-types.ts";
/**
 * Everything the worker does between the gateway link and the provider runtimes
 * (docs/worker-config.md, docs/codex-adapter.md). Used by main.ts and by integration tests.
 *
 * - Remote config: validated, applied per instance. Changed runtimes drain admitted turns and owned background
 *   tasks before replacement; new work waits for the latest snapshot. Codex has one app-server per instance,
 *   including instances without environment variables. Unchanged instances keep running.
 * - Commands: answered once; final results are remembered in the journal for redelivery.
 * - Events: journal first (inside the runtimes), then sent when the link is up.
 * - Interactions and agent bus tool calls: forwarded to the gateway, re-sent after reconnect until
 *   answered (the gateway answers a re-sent call from its stored result).
 * - Model catalog: listed after every applied config (no model turn), sent as ModelCatalog and
 *   re-sent after a reconnect; ListModels lists again on request.
 * - Background tasks die with their provider process: after a crash (recover: worker_lost) or a runtime restart
 *   (worker_restart), the ones the journal still has open are closed as interrupted, with their end time. A graceful
 *   stop (shutdown) closes them as worker_shutdown while the link is still up and waits for the gateway's ack (flush),
 *   so the agent hears why (docs/execution.md, "Pobudka"). Turns of the previous process are settled too (recover).
 * - Running turns are reported in Hello (runningTurns): the gateway ends the ones it believes run here but
 *   do not; an interrupt for a turn that does not run here fails with TURN_NOT_RUNNING.
 * - Attachments (docs/protocol.md, "Załączniki"): a turn's files are fetched from the gateway (FetchBlob) into
 *   `<data_dir>/attachments/<thread>/<attachment>/` before the harness gets the turn.
 * - Images (docs/agent-bus.md, "view_image"): view_image runs here; every image a model saw gets a preview, sent
 *   to the gateway (BlobChunk) right before the event that shows it.
 */

/** Read-only queries: answered again on redelivery instead of being remembered in the journal. */
const QUERIES: ReadonlySet<Command["kind"]["case"]> = new Set(["listMentionCatalog", "searchFiles", "generateText"]);

/** Never redelivered from an outbox (sent directly): not remembered either. */
const NOT_REMEMBERED: ReadonlySet<Command["kind"]["case"]> = new Set([
  ...QUERIES,
  "installCli",
  "getProviderAccounts",
  "readWorkspaceOrigin",
  "readGitPrContext",
  "initRepository",
  "cloneRepository",
  "cancelCloneRepository",
  "workspaceCopy",
  "botFile",
  "switchThreadBranch",
  "listGitRefs",
  "createWorktree",
  "renameWorktreeBranch",
  "scanWorktrees",
  "revealWorktree",
  "revealPath",
  // Explicit owner actions on one file: answered once, never redelivered.
  "readFile",
  "openFile",
  "writeFile",
  "deleteFile",
  "scanImportSources",
  "readImportPage",
  "readImportLibraryItem",
  // A secret header's value: never written to the journal or remembered for a retry.
  "readImportSecret",
  "adoptImportedSession",
  "removeImportedCopy",
]);

export class WorkerHost {
  readonly #copies: WorkspaceCopies;
  readonly #cliChecks: UpdateCheckTimer;
  readonly #commands = new Map<string, Promise<CommandResultInit | undefined>>();
  readonly secrets: ThreadSecretFiles;
  readonly cli: CliTools;
  readonly environment: WorkerAgentEnvironment;
  readonly #ctx: HostContext;
  get updateDraining(): boolean {
    return this.#ctx.state.updateDraining;
  }
  get attachmentsRoot(): string {
    return this.#ctx.state.files.root;
  }
  /** Managed root of git worktrees (Hello.worktrees_root, docs/worktrees.md). */
  get worktreesRoot(): string {
    return this.#ctx.state.worktreeRoots.primary;
  }
  get config(): AppliedConfig | undefined {
    return this.#ctx.state.config;
  }
  constructor(options: WorkerHostOptions) {
    this.#copies = new WorkspaceCopies(options.dataDir);
    this.#cliChecks = new UpdateCheckTimer(options.cliCheckClock);
    const state = new HostState(options);
    this.#ctx = new HostContext(state, {
      applyConfig: (message) => this.applyConfig(message),
      sendPreviews: (link, event) => this.sendPreviews(link, event),
    });
    this.secrets = state.secrets;
    state.heads = new HeadTracker((heads) => this.#ctx.ops.send({ case: "gitHeads", value: { heads } }));
    this.environment = new WorkerAgentEnvironment({
      homes: () => ({ dataDir: options.dataDir, deviceHomes: state.deviceHomes, config: state.config }),
      send: (report) => this.#ctx.ops.send({ case: "agentEnvironment", value: report }),
    });
    this.cli = this.#ctx.state.cli = new CliTools({
      dataDir: options.dataDir,
      probe: options.cliProbe ?? systemCliProbe(installKind() === "docker"),
      configured: () => ({
        ...(this.#ctx.state.received?.claude?.executablePath && {
          claude: this.#ctx.state.received.claude.executablePath,
        }),
        ...(this.#ctx.state.received?.codex?.executablePath && {
          codex: this.#ctx.state.received.codex.executablePath,
        }),
        ...(this.#ctx.state.received?.grok?.executablePath && { grok: this.#ctx.state.received.grok.executablePath }),
      }),
      send: (report) => this.#ctx.ops.send({ case: "cliTools", value: report }),
      progress: (progress) => this.#ctx.ops.send({ case: "cliInstallProgress", value: progress }),
      busy: (provider) => this.#busy(provider),
      installed: async () => {
        if (this.#ctx.state.received) await this.#ctx.ops.probe();
      },
      log: (message) => this.#ctx.ops.log(message),
      ...(options.cliEnv && { env: options.cliEnv }),
    });
  }
  setUpdateDraining(value: boolean): void {
    this.#ctx.state.updateDraining = value;
  }

  async updateIdle(): Promise<boolean> {
    return (
      this.#ctx.state.admitting === 0 &&
      this.#ctx.state.running.size === 0 &&
      this.#ctx.state.generations.size === 0 &&
      (await this.#ctx.state.options.runtime.runPromise(Journal.use((j) => j.openBackgroundTasks()))).length === 0
    );
  }

  /** Running turns of a provider on this worker, and its turns being admitted. */
  #busy(provider: Provider): number {
    let running = this.#ctx.state.admittingBy.get(provider) ?? 0;

    for (const key of this.#ctx.state.running)
      if (this.#ctx.state.threadProviders.get(key.split("/")[0] ?? "") === provider) running++;

    return running;
  }

  attach(link: GatewayLink): void {
    this.#ctx.state.link = link;
    this.environment.refresh(true);

    for (const { request } of this.#ctx.state.interactions.values())
      this.#ctx.ops.send({ case: "interactionRequest", value: request });

    for (const { call } of this.#ctx.state.toolCalls.values())
      this.#ctx.ops.send({ case: "agentToolCall", value: call });

    if (this.#ctx.state.catalog) this.#ctx.ops.send({ case: "modelCatalog", value: this.#ctx.state.catalog });
    this.#ctx.state.heads.snapshot();
    void this.#ctx.state.cli.report().catch(() => undefined);
  }

  detach(link: GatewayLink): void {
    if (this.#ctx.state.link === link) {
      this.#ctx.state.link = undefined;
      void this.#ctx.ops.closeClones();
    }

    // The redelivered StartTurn asks again on the next link.
    for (const [id, fetch] of this.#ctx.state.fetches) {
      this.#ctx.state.fetches.delete(id);
      fetch.reject(new AttachmentError("the gateway link closed while an attachment was on its way", false));
    }
  }

  /** A chunk of an attachment the worker asked for (FetchBlob). */
  handleBlobChunk(chunk: BlobChunk): void {
    const fetch = this.#ctx.state.fetches.get(chunk.requestId);

    if (!fetch) return;

    if (chunk.error) {
      this.#ctx.state.fetches.delete(chunk.requestId);
      fetch.reject(new AttachmentError(`the gateway could not hand over the attachment: ${chunk.error}`, true));

      return;
    }

    fetch.chunks.push(chunk.data);

    if (!chunk.last) return;
    this.#ctx.state.fetches.delete(chunk.requestId);
    fetch.resolve(new Uint8Array(Buffer.concat(fetch.chunks)));
  }

  /** Previews an event points to, sent on `link` before the event (journal resend after Welcome). */
  sendPreviews(link: GatewayLink, event: ThreadEvent): void {
    this.#ctx.state.previews.sendFor(link, event, (chunk) => link.send({ case: "blobChunk", value: chunk }));
  }

  async applyConfig(message: WorkerConfig): Promise<ConfigAppliedInit> {
    const probe = this.#ctx.state.options.probe ?? (await prepareSystemProbe(message));
    const result = applyWorkerConfig(message, probe, this.#ctx.ops.homes());

    if (result.applied) {
      this.#ctx.state.received = message;
      this.#cliChecks.start(message.cliUpdateCheckMinutes ?? 360, this.#cliChecks.clock.now(), async () => {
        await this.cli.report().catch(() => undefined);
      });
      this.#ctx.state.config = result.config;
      this.environment.refresh();
      await this.#ctx.ops.reconcileRuntimes();
      void this.#ctx.ops.publishCatalog(message.version);
    }

    return result.report;
  }

  handleInteractionResponse(response: InteractionResponse): void {
    const pending = this.#ctx.state.interactions.get(response.requestId);

    if (!pending) return;
    this.#ctx.state.interactions.delete(response.requestId);
    pending.resolve(response);
  }

  handleAgentToolResult(result: AgentToolResult): void {
    const pending = this.#ctx.state.toolCalls.get(result.callId);

    if (!pending) return;
    this.#ctx.state.toolCalls.delete(result.callId);
    pending.resolve(result);
  }

  /**
   * The command's result; undefined while the worker stops (shutdown): no answer, so the command stays in the
   * gateway's outbox and the next process gets it (an error would end e.g. a turn the next process can run).
   */
  async handleCommand(command: Command): Promise<CommandResultInit | undefined> {
    const pending = this.#commands.get(command.commandId);

    if (pending) return pending;
    const result = this.#handleCommand(command).finally(() => this.#commands.delete(command.commandId));
    this.#commands.set(command.commandId, result);

    return result;
  }

  async #handleCommand(command: Command): Promise<CommandResultInit | undefined> {
    const known = await this.#ctx.state.options.runtime.runPromise(
      Journal.use((j) => j.commandResult(command.commandId)),
    );

    if (known) return known;

    if (this.#ctx.state.shuttingDown) return undefined;

    // Leave new work unacknowledged in the durable gateway outbox until the update completes/restarts.
    const admission = ["startTurn", "createThread", "generateText", "setGoal", "runBotTurn"].includes(
      command.kind.case ?? "",
    );

    if (admission && this.#ctx.state.updateDraining) return undefined;
    const provider = admission ? commandProvider(command) : undefined;

    if (admission) this.#ctx.state.admitting++;

    if (provider) this.#ctx.state.admittingBy.set(provider, (this.#ctx.state.admittingBy.get(provider) ?? 0) + 1);

    try {
      // A CLI being installed: its new work waits for the install to end (docs/provider-cli.md).
      if (provider) await this.#ctx.state.cli.settled(provider);

      if (command.kind.case === "workspaceCopy" && command.kind.value.action.case === "scan")
        this.#ctx.ops.checkCwd(command.kind.value.action.value.rootPath);

      const output =
        command.kind.case === "workspaceCopy"
          ? { workspaceCopy: await this.#copies.execute(command.kind.value) }
          : await this.#ctx.ops.execute(command);

      const result: CommandResultInit = {
        commandId: command.commandId,
        ok: true,
        ...(output.workspaceCopy && { workspaceCopy: output.workspaceCopy }),
        ...(output.botFile && { botFile: output.botFile }),
        ...(output.entries && { entries: output.entries }),
        ...(output.directoryPath && { directoryPath: output.directoryPath }),
        ...(output.models && { models: output.models }),
        ...(output.login && { login: output.login }),
        ...(output.providerAccounts && { providerAccounts: output.providerAccounts }),
        ...(output.mentionCatalog && { mentionCatalog: output.mentionCatalog }),
        ...(output.fileSearch && { fileSearch: output.fileSearch }),
        ...(output.generatedText !== undefined && { generatedText: output.generatedText }),
        ...(output.gitRefs && { gitRefs: output.gitRefs }),
        ...(output.switchedHead && { switchedHead: output.switchedHead }),
        ...(output.gitPrContext && { gitPrContext: output.gitPrContext }),
        ...(output.workspaceOrigin !== undefined && { workspaceOrigin: output.workspaceOrigin }),
        ...(output.workspaceCloneUrl !== undefined && { workspaceCloneUrl: output.workspaceCloneUrl }),
        ...(output.worktree && { worktree: output.worktree }),
        ...(output.worktreeStatuses && { worktreeStatuses: output.worktreeStatuses }),
        ...(output.worktreeBranchDeleted !== undefined && { worktreeBranchDeleted: output.worktreeBranchDeleted }),
        ...(output.importScan && { importScan: output.importScan }),
        ...(output.importPage && { importPage: output.importPage }),
        ...(output.importedSessionId && { importedSessionId: output.importedSessionId }),
        ...(output.importLibraryContent && { importLibraryContent: output.importLibraryContent }),
        ...(output.importSecret && { importSecret: output.importSecret }),
        ...(output.file && { file: output.file }),
      };

      if (!NOT_REMEMBERED.has(command.kind.case)) await this.#remember(result);

      return result;
    } catch (error) {
      // The runtimes went down under it: the next process runs it.
      if (this.#ctx.state.shuttingDown) return undefined;

      const failure =
        error instanceof CommandError
          ? error
          : new CommandError("THREAD_ERROR", error instanceof Error ? error.message : String(error), true);

      const result: CommandResultInit = {
        commandId: command.commandId,
        ok: false,
        errorCode: failure.code,
        errorMessage: failure.message,
      };

      if (failure.final && !NOT_REMEMBERED.has(command.kind.case)) await this.#remember(result);

      return result;
    } finally {
      if (admission) this.#ctx.state.admitting--;

      if (provider) this.#ctx.state.admittingBy.set(provider, (this.#ctx.state.admittingBy.get(provider) ?? 1) - 1);
    }
  }

  async close(): Promise<void> {
    await this.#ctx.ops.closeClones();
    await this.#copies.close();
    this.#ctx.state.closing = true;

    for (const run of this.#ctx.state.shellRuns.values()) run.controller.abort("worker_shutdown");
    await Promise.allSettled([...this.#ctx.state.shellRuns.values()].map((r) => r.pending));
    await this.#ctx.state.accounts.close();
    this.#ctx.ops.wakeRuntimes();
    await this.#ctx.state.runtimeReconcile;
    this.#cliChecks.stop();
    this.environment.stop();
    this.#ctx.state.heads.close();

    try {
      await this.#ctx.ops.closeBots();

      for (const generation of this.#ctx.state.generations.keys()) generation.abort();
      await Promise.allSettled(this.#ctx.state.generations.values());

      for (const group of Array.from(this.#ctx.state.codex.keys())) await this.#ctx.ops.stopCodex(group);
      await this.#ctx.ops.closeCodexOrphans();

      for (const id of Array.from(this.#ctx.state.claude.keys())) await this.#ctx.ops.stopClaude(id);

      for (const handle of this.#ctx.state.grok.values()) await handle.runtime.close();
      this.#ctx.state.grok.clear();
      await Promise.allSettled(this.#commands.values());
    } finally {
      // Keep masking late provider output until its processes have stopped.
      this.#ctx.state.secrets.close();
    }
  }

  /**
   * Graceful stop (SIGTERM: restart, deploy): the provider runtimes stop and the background tasks they ran end as
   * interrupted with stop_reason worker_shutdown and their end time, journaled and sent while the link is up.
   * Commands after this find no runtime (not final: they wait for the next process). Returns how many tasks ended.
   */
  async shutdown(): Promise<number> {
    this.#ctx.state.shuttingDown = true;
    const before = await this.#ctx.state.options.runtime.runPromise(Journal.use((j) => j.beginShutdown()));
    await this.close();

    return before;
  }

  /** Waits until the gateway acked every journaled event (or the time is up); true when nothing is left. */
  async flush(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const left = await this.#ctx.state.options.runtime.runPromise(Journal.use((j) => j.cursors()));

      if (left.length === 0) return true;

      if (Date.now() >= deadline || !this.#ctx.state.link) return false;
      await Bun.sleep(100);
    }
  }

  /**
   * At startup: turns and background tasks of the previous process are gone (docs/durability.md, 3.4;
   * docs/execution.md, "Trwałość"). Each open turn is settled from its harness's transcript (providers/reconcile.ts):
   * what the harness recorded but the previous process never forwarded is journaled, open items get their real end,
   * and the turn ends the way the harness ended it, else as interrupted by the system ("worker restarted mid-turn").
   * Their ends go through the journal like any event.
   */
  async recover(): Promise<{ turns: number; tasks: number; fromTranscript: number }> {
    await recoverShellInputs(this.#ctx);
    const open = await this.#ctx.state.options.runtime.runPromise(Journal.use((j) => j.openTurns()));
    let fromTranscript = 0;

    for (const turn of open) {
      const { events, record } = await this.#ctx.state.options.runtime.runPromise(
        reconcileTurn(turn, WORKER_RESTARTED),
      );

      if (record) fromTranscript++;

      for (const event of events) this.#ctx.ops.sendEvent(event);
    }

    // A graceful stop closed its tasks (worker_shutdown); whatever is still open died without a record: a crash.
    return { turns: open.length, tasks: await this.#ctx.ops.closeOrphans(() => true, "worker_lost"), fromTranscript };
  }

  /** Turns this process runs now (Hello.running_turns). */
  runningTurns(): { threadId: string; turnId: string }[] {
    return [...this.#ctx.state.running].map((key) => {
      const [threadId = "", turnId = ""] = key.split("/");

      return { threadId, turnId };
    });
  }

  async #remember(result: CommandResultInit): Promise<void> {
    await this.#ctx.state.options.runtime.runPromise(Journal.use((j) => j.rememberCommand(result)));
  }
}
