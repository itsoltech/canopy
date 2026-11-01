import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { clone, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import {
  BackgroundTaskKind,
  ItemSchema,
  ItemStatus,
  Provider,
  type AgentToolCall,
  type AgentToolResult,
  type Command,
  type DirectoryEntrySchema,
  type CommandResultSchema,
  type ConfigAppliedSchema,
  type InteractionRequest,
  type InteractionResponse,
  type Item,
  type ProfileModelsSchema,
  type ThreadEvent,
  type WorkerConfig,
  TurnOutcome,
} from "@open-agents/contracts";
import { Cause, Context, Effect, Exit, Layer, Scope, type ManagedRuntime } from "effect";
import { applyWorkerConfig, isAllowedPath, type AppliedConfig, type DeviceProbe, systemProbe } from "../config/remote.ts";
import type { GatewayLink } from "../gateway-link/index.ts";
import { Journal } from "../journal/index.ts";
import { deviceClaudeHome, prepareClaudeHome } from "../providers/claude/home.ts";
import { ClaudeThreads } from "../providers/claude/threads.ts";
import { deviceCodexHome, prepareCodexHome } from "../providers/codex/home.ts";
import { codexAppServerLaunch } from "../providers/codex/launch.ts";
import { CodexThreads } from "../providers/codex/threads.ts";
import { claudeConfiguredEffort, readClaudeUserSettings, readCodexConfiguredEffort } from "../providers/default-effort.ts";
import type { ResolvedProfile } from "../providers/profiles.ts";
import { reconcileTurn, WORKER_RESTARTED } from "../providers/reconcile.ts";
import type { SteerError } from "../providers/turn-input.ts";

/**
 * Everything the worker does between the gateway link and the provider runtimes
 * (docs/worker-config.md, docs/codex-adapter.md). Used by main.ts and by integration tests.
 *
 * - Remote config: validated, applied; the Codex runtime is rebuilt when its settings change,
 *   but never under a running turn (deferred until the worker is idle).
 * - Commands: answered once; final results are remembered in the journal for redelivery.
 * - Events: journal first (inside the runtimes), then sent when the link is up.
 * - Interactions and agent bus tool calls: forwarded to the gateway, re-sent after reconnect until
 *   answered (the gateway answers a re-sent call from its stored result).
 * - Model catalog: listed after every applied config (no model turn), sent as ModelCatalog and
 *   re-sent after a reconnect; ListModels lists again on request.
 * - Background tasks die with their provider process: after a crash (recover) or a runtime restart, the
 *   ones the journal still has open are closed as interrupted. Turns of the previous process too (recover).
 * - Running turns are reported in Hello (runningTurns): the gateway ends the ones it believes run here but
 *   do not; an interrupt for a turn that does not run here fails with TURN_NOT_RUNNING.
 */

type CommandResultInit = MessageInitShape<typeof CommandResultSchema>;
type ConfigAppliedInit = MessageInitShape<typeof ConfigAppliedSchema>;
type DirectoryEntryInit = MessageInitShape<typeof DirectoryEntrySchema>;
type ProfileModelsInit = MessageInitShape<typeof ProfileModelsSchema>;
interface CommandOutput {
  readonly entries?: DirectoryEntryInit[];
  readonly models?: ProfileModelsInit[];
}

export interface WorkerHostOptions {
  readonly runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
  readonly dataDir: string;
  readonly clientVersion: string;
  readonly probe?: DeviceProbe;
  /**
   * The device owner's Claude and Codex homes (login, default effort). Default: $CLAUDE_CONFIG_DIR / $CODEX_HOME
   * of the worker process at start, else ~/.claude and ~/.codex.
   */
  readonly deviceHomes?: { readonly claude: string; readonly codex: string };
  readonly log?: (message: string) => void;
}

interface ProviderRuntimeHandle<S> {
  readonly key: string;
  readonly scope: Scope.Closeable;
  readonly context: Context.Context<S>;
}

/** InterruptTurn for a turn this process does not run (the gateway ends the turn). */
const TURN_NOT_RUNNING = "TURN_NOT_RUNNING";

class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Deterministic failures are remembered for redelivery; transient ones are not. */
    readonly final: boolean,
  ) {
    super(message);
  }
}

export class WorkerHost {
  readonly #options: WorkerHostOptions;
  #config: AppliedConfig | undefined;
  #link: GatewayLink | undefined;
  #codex: ProviderRuntimeHandle<CodexThreads> | undefined;
  #claude: ProviderRuntimeHandle<ClaudeThreads> | undefined;
  #rebuildWanted = false;
  #codexRestart: Promise<void> | undefined;
  readonly #running = new Set<string>();
  readonly #interactions = new Map<string, { request: InteractionRequest; resolve: (r: InteractionResponse) => void }>();
  readonly #toolCalls = new Map<string, { call: AgentToolCall; resolve: (r: AgentToolResult) => void }>();
  /** Last model catalog (ModelCatalog), re-sent after a reconnect. */
  #catalog: { configVersion: bigint; profiles: ProfileModelsInit[] } | undefined;
  #catalogRun = 0;
  /** Taken at start: the Claude runtime points this process's CLAUDE_CONFIG_DIR at the isolated home. */
  readonly #deviceHomes: { readonly claude: string; readonly codex: string };

  constructor(options: WorkerHostOptions) {
    this.#options = options;
    this.#deviceHomes = options.deviceHomes ?? { claude: deviceClaudeHome(process.env), codex: deviceCodexHome(process.env) };
  }

  get config(): AppliedConfig | undefined {
    return this.#config;
  }

  attach(link: GatewayLink): void {
    this.#link = link;
    for (const { request } of this.#interactions.values()) this.#send({ case: "interactionRequest", value: request });
    for (const { call } of this.#toolCalls.values()) this.#send({ case: "agentToolCall", value: call });
    if (this.#catalog) this.#send({ case: "modelCatalog", value: this.#catalog });
  }

  detach(link: GatewayLink): void {
    if (this.#link === link) this.#link = undefined;
  }

  async applyConfig(message: WorkerConfig): Promise<ConfigAppliedInit> {
    const result = applyWorkerConfig(message, this.#options.probe ?? systemProbe);
    if (result.applied) {
      this.#config = result.config;
      await this.#reconcileRuntimes();
      void this.#publishCatalog(message.version);
    }
    return result.report;
  }

  /** Lists every provider + profile of the current config and sends the catalog (the newest run wins). */
  async #publishCatalog(configVersion: bigint): Promise<void> {
    const run = ++this.#catalogRun;
    const profiles = await this.#listModels(Provider.UNSPECIFIED, "");
    if (run !== this.#catalogRun) return;
    this.#catalog = { configVersion, profiles };
    this.#send({ case: "modelCatalog", value: this.#catalog });
    this.#log(`model catalog: ${profiles.map((p) => `${Provider[p.provider ?? 0]?.toLowerCase()}/${p.profileId} ${p.models?.length ?? 0}${p.detail ? " (incomplete)" : ""}`).join(", ")}`);
  }

  /** Models of the enabled providers' usable profiles; a failing pair reports its problem instead. */
  async #listModels(provider: Provider, profileId: string): Promise<ProfileModelsInit[]> {
    const config = this.#config;
    if (!config) return [];
    const pairs: { provider: Provider; profile: string }[] = [];
    for (const status of config.profiles) {
      const resolved = status.resolved;
      if (!resolved || (profileId && resolved.id !== profileId)) continue;
      if (this.#claude && usableBy(resolved, "claude") && (!provider || provider === Provider.CLAUDE)) pairs.push({ provider: Provider.CLAUDE, profile: resolved.id });
      if (this.#codex && usableBy(resolved, "codex") && (!provider || provider === Provider.CODEX)) pairs.push({ provider: Provider.CODEX, profile: resolved.id });
    }
    return Promise.all(
      pairs.map(async ({ provider: p, profile }): Promise<ProfileModelsInit> => {
        try {
          const listed: { models: ProfileModelsInit["models"]; detail?: string } =
            p === Provider.CLAUDE
              ? await this.#runClaude((threads) => threads.listModels(profile))
              : await this.#runCodex(Provider.CODEX, (threads) => threads.listModels(profile));
          return { provider: p, profileId: profile, models: listed.models ?? [], ...(listed.detail && { detail: listed.detail }), listedAt: timestampNow() };
        } catch (error) {
          return { provider: p, profileId: profile, models: [], detail: error instanceof Error ? error.message : String(error), listedAt: timestampNow() };
        }
      }),
    );
  }

  handleInteractionResponse(response: InteractionResponse): void {
    const pending = this.#interactions.get(response.requestId);
    if (!pending) return;
    this.#interactions.delete(response.requestId);
    pending.resolve(response);
  }

  handleAgentToolResult(result: AgentToolResult): void {
    const pending = this.#toolCalls.get(result.callId);
    if (!pending) return;
    this.#toolCalls.delete(result.callId);
    pending.resolve(result);
  }

  async handleCommand(command: Command): Promise<CommandResultInit> {
    const known = await this.#options.runtime.runPromise(Journal.use((j) => j.commandResult(command.commandId)));
    if (known) return known;
    try {
      const output = await this.#execute(command);
      const result: CommandResultInit = {
        commandId: command.commandId,
        ok: true,
        ...(output.entries && { entries: output.entries }),
        ...(output.models && { models: output.models }),
      };
      await this.#remember(result);
      return result;
    } catch (error) {
      const failure =
        error instanceof CommandError ? error : new CommandError("THREAD_ERROR", error instanceof Error ? error.message : String(error), true);
      const result: CommandResultInit = { commandId: command.commandId, ok: false, errorCode: failure.code, errorMessage: failure.message };
      if (failure.final) await this.#remember(result);
      return result;
    }
  }

  async close(): Promise<void> {
    await this.#stopCodex();
    await this.#stopClaude();
  }

  /**
   * At startup: turns and background tasks of the previous process are gone (docs/durability.md, 3.4;
   * docs/execution.md, "Trwałość"). Each open turn is settled from its harness's transcript (providers/reconcile.ts):
   * what the harness recorded but the previous process never forwarded is journaled, open items get their real end,
   * and the turn ends the way the harness ended it, else as interrupted by the system ("worker restarted mid-turn").
   * Their ends go through the journal like any event.
   */
  async recover(): Promise<{ turns: number; tasks: number; fromTranscript: number }> {
    const open = await this.#options.runtime.runPromise(Journal.use((j) => j.openTurns()));
    let fromTranscript = 0;
    for (const turn of open) {
      const { events, record } = await this.#options.runtime.runPromise(reconcileTurn(turn, WORKER_RESTARTED));
      if (record) fromTranscript++;
      for (const event of events) this.#send({ case: "threadEvent", value: event });
    }
    return { turns: open.length, tasks: await this.#closeOrphans(() => true, "worker_restart"), fromTranscript };
  }

  /** Turns this process runs now (Hello.running_turns). */
  runningTurns(): { threadId: string; turnId: string }[] {
    return [...this.#running].map((key) => {
      const [threadId = "", turnId = ""] = key.split("/");
      return { threadId, turnId };
    });
  }

  // ------------------------------------------------------------------ commands

  async #execute(command: Command): Promise<CommandOutput> {
    const kind = command.kind;
    if (kind.case === "listDirectory") return { entries: this.#listDirectory(kind.value.path) };
    const config = this.#config;
    if (!config) throw new CommandError("WORKER_NOT_CONFIGURED", "the worker has no configuration yet", false);
    switch (kind.case) {
      case "createThread": {
        const spec = kind.value.thread;
        if (!spec) throw new CommandError("INVALID_COMMAND", "thread spec missing", true);
        this.#checkCwd(config, spec.cwd);
        const fork = kind.value.fork;
        if (spec.provider === Provider.CLAUDE) await this.#runClaude((threads) => threads.create(spec, fork));
        else await this.#runCodex(spec.provider, (threads) => threads.create(spec, fork));
        return {};
      }
      case "startTurn": {
        const { thread: spec, turnId, input, model, effort } = kind.value;
        if (!spec || !input) throw new CommandError("INVALID_COMMAND", "thread spec or input missing", true);
        const settings = { model, effort };
        if (spec.provider === Provider.CLAUDE) await this.#runClaude((threads) => threads.startTurn(spec, turnId, input, settings));
        else await this.#runCodex(spec.provider, (threads) => threads.startTurn(spec, turnId, input, settings));
        return {};
      }
      case "steerTurn": {
        const { threadId, turnId, inputId, input } = kind.value;
        if (!input || !inputId) throw new CommandError("INVALID_COMMAND", "input or input_id missing", true);
        // Like InterruptTurn: the runtime with the running turn takes it.
        const claude = this.#claude;
        const steer = (effect: Effect.Effect<void, SteerError>) =>
          effect.pipe(Effect.catchTag("SteerError", (error) => Effect.die(new CommandError(error.code, error.message, true))));
        if (claude && Context.get(claude.context, ClaudeThreads).running(threadId)) {
          await this.#runClaude((threads) => steer(threads.steer(threadId, turnId, inputId, input)));
        } else if (this.#codex) {
          await this.#runCodex(Provider.CODEX, (threads) => steer(threads.steer(threadId, turnId, inputId, input)));
        } else {
          throw new CommandError("STEER_NOT_RUNNING", "the turn is not running on this worker", true);
        }
        return {};
      }
      case "listModels":
        return { models: await this.#listModels(kind.value.provider, kind.value.profileId) };
      case "interruptTurn": {
        const { threadId, turnId } = kind.value;
        // E.g. the turn died with the previous process: the gateway ends it on its side.
        if (!this.#running.has(`${threadId}/${turnId}`)) throw new CommandError(TURN_NOT_RUNNING, "the turn is not running on this worker", true);
        // The command does not name the provider: the runtime with the running turn takes it.
        const claude = this.#claude;
        if (claude && Context.get(claude.context, ClaudeThreads).running(threadId)) {
          await this.#runClaude((threads) => threads.interrupt(threadId, turnId));
        } else {
          await this.#runCodex(Provider.CODEX, (threads) => threads.interrupt(threadId, turnId));
        }
        return {};
      }
      case "setGoal": {
        const { thread: spec, directive, objective, nativeTokenBudget } = kind.value;
        if (!spec) throw new CommandError("INVALID_COMMAND", "thread spec missing", true);
        // Claude goals are /goal turns in the input stream (docs/goals.md); the gateway queues them as turns.
        if (spec.provider === Provider.CLAUDE) throw new CommandError("UNSUPPORTED", "Claude goals are set with /goal turns", true);
        await this.#runCodex(spec.provider, (threads) => threads.setGoal(spec, directive, objective, nativeTokenBudget));
        return {};
      }
      case "stopTask": {
        const { threadId, taskId } = kind.value;
        const claude = this.#claude && Context.get(this.#claude.context, ClaudeThreads);
        const codex = this.#codex && Context.get(this.#codex.context, CodexThreads);
        if (claude?.backgroundTasks().get(threadId)?.includes(taskId)) await this.#runClaude((threads) => threads.stopTask(threadId, taskId));
        else if (codex?.backgroundTasks().get(threadId)?.includes(taskId)) await this.#runCodex(Provider.CODEX, (threads) => threads.stopTask(threadId, taskId));
        // No process runs it: if the journal still has it open, its process is gone, so it ends here.
        else await this.#closeOrphans((threadOf, item) => threadOf === threadId && taskOf(item) === taskId, "stopped_by_user");
        return {};
      }
      case "unloadThread":
        return {}; // nothing to free yet: Codex threads share one app-server process, Claude turns end with their query
      default:
        throw new CommandError("UNIMPLEMENTED", `${kind.case ?? "empty"} is not supported by this worker yet`, true);
    }
  }

  async #runCodex<A, E>(provider: Provider, use: (threads: CodexThreads["Service"]) => Effect.Effect<A, E>): Promise<A> {
    if (provider !== Provider.CODEX) throw new CommandError("PROVIDER_UNAVAILABLE", `${Provider[provider]} is not supported by this worker yet`, true);
    await this.#restartFailedCodex();
    if (!this.#codex) throw new CommandError("PROVIDER_UNAVAILABLE", this.#config?.codex.problem ?? "codex is disabled", false);
    return this.#runIn(Effect.provide(CodexThreads.use(use), this.#codex.context));
  }

  /**
   * The app-server exited on its own (its turns are already settled from their rollouts): the next command gets a
   * new one. Threads resume in it (thread/resume), so they stay usable.
   */
  async #restartFailedCodex(): Promise<void> {
    const codex = this.#codex;
    const failure = codex && Context.get(codex.context, CodexThreads).failure();
    if (!failure) return;
    this.#codexRestart ??= (async () => {
      this.#log(`${failure}; starting a new one`);
      const config = this.#config;
      await this.#reconcileCodex(config, config ? this.#codexKey(config) : undefined);
    })().finally(() => (this.#codexRestart = undefined));
    await this.#codexRestart;
  }

  async #runClaude<A, E>(use: (threads: ClaudeThreads["Service"]) => Effect.Effect<A, E>): Promise<A> {
    if (!this.#claude) throw new CommandError("PROVIDER_UNAVAILABLE", this.#config?.claude.problem ?? "claude is disabled", false);
    return this.#runIn(Effect.provide(ClaudeThreads.use(use), this.#claude.context));
  }

  async #runIn<A, E>(effect: Effect.Effect<A, E, Journal>): Promise<A> {
    const exit = await this.#options.runtime.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    const error = Cause.squash(exit.cause);
    if (error instanceof CommandError) throw error;
    // The harness itself refused or failed (e.g. Codex answered the request with an error): the gateway says so.
    const code = error && typeof error === "object" && (error as { harness?: unknown }).harness === true ? "HARNESS_ERROR" : "THREAD_ERROR";
    throw new CommandError(code, error instanceof Error || (error && typeof error === "object" && "message" in error) ? String((error as { message: unknown }).message) : String(error), true);
  }

  #checkCwd(config: AppliedConfig, cwd: string): void {
    let real: string;
    try {
      real = realpathSync(cwd);
    } catch {
      throw new CommandError("CWD_NOT_FOUND", `${cwd} does not exist`, true);
    }
    if (!isAllowedPath(config, real)) throw new CommandError("CWD_NOT_ALLOWED", `${cwd} is outside the allowed roots`, true);
  }

  #listDirectory(path: string) {
    const config = this.#config;
    if (!config) throw new CommandError("WORKER_NOT_CONFIGURED", "the worker has no configuration yet", false);
    const entry = (dir: string, name: string) => {
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        // broken symlink or no permission: listed as a file
      }
      return { name, isDir, isGitRepo: isDir && existsSync(join(full, ".git")) };
    };
    if (!path) return config.allowedRoots.map((root) => ({ ...entry(root, ""), name: root }));
    this.#checkCwd(config, path);
    return readdirSync(realpathSync(path))
      .sort()
      .slice(0, 1000)
      .map((name) => entry(realpathSync(path), name));
  }

  async #remember(result: CommandResultInit): Promise<void> {
    await this.#options.runtime.runPromise(Journal.use((j) => j.rememberCommand(result)));
  }

  // ------------------------------------------------------------------ Codex runtime lifecycle

  #codexKey(config: AppliedConfig): string | undefined {
    if (!config.codex.enabled || !config.codex.executable) return undefined;
    return JSON.stringify({
      executable: config.codex.executable,
      linkDeviceLogin: config.codex.linkDeviceLogin,
      nativeTools: config.nativeTools,
      profiles: config.profiles.map((p) => p.resolved ?? null),
    });
  }

  /** Provider runtimes follow the configuration, but are never rebuilt under a running turn. */
  async #reconcileRuntimes(): Promise<void> {
    const config = this.#config;
    const codexKey = config ? this.#codexKey(config) : undefined;
    const claudeKey = config ? this.#claudeKey(config) : undefined;
    if (codexKey === this.#codex?.key && claudeKey === this.#claude?.key) return;
    if (this.#running.size > 0) {
      this.#rebuildWanted = true;
      this.#log(`provider settings changed; restart deferred until ${this.#running.size} running turn(s) finish`);
      return;
    }
    this.#rebuildWanted = false;
    if (codexKey !== this.#codex?.key) await this.#reconcileCodex(config, codexKey);
    if (claudeKey !== this.#claude?.key) await this.#reconcileClaude(config, claudeKey);
  }

  #claudeKey(config: AppliedConfig): string | undefined {
    if (!config.claude.enabled || !config.claude.executable) return undefined;
    return JSON.stringify({
      executable: config.claude.executable,
      linkDeviceLogin: config.claude.linkDeviceLogin,
      nativeTools: config.nativeTools,
      profiles: config.profiles.map((p) => p.resolved ?? null),
    });
  }

  async #reconcileClaude(config: AppliedConfig | undefined, key: string | undefined): Promise<void> {
    await this.#stopClaude();
    if (!config || !key) return;
    const home = prepareClaudeHome({ dataDir: this.#options.dataDir, linkDeviceLogin: config.claude.linkDeviceLogin, deviceClaudeHome: this.#deviceHomes.claude });
    if (home.problem) this.#log(`claude home: ${home.problem}`);
    const profiles = config.profiles.flatMap((p) => (p.resolved && usableBy(p.resolved, "claude") ? [p.resolved] : []));
    const layer = ClaudeThreads.layer({
      home: home.path,
      ...(config.claude.executable && { executable: config.claude.executable }),
      nativeTools: config.nativeTools,
      baseEnv: process.env,
      configuredEffort: (names) => claudeConfiguredEffort(readClaudeUserSettings(this.#deviceHomes.claude), process.env, names),
      profile: (id) => profiles.find((p) => p.id === (id || "native")),
      publish: (event) => this.#publish(event),
      interact: (request) => this.#interact(request),
      callTool: (call) => this.#callTool(call),
    });
    const scope = await Effect.runPromise(Scope.make());
    const context = await this.#options.runtime.runPromise(Layer.buildWithScope(layer, scope));
    this.#claude = { key, scope, context };
    this.#log("claude runtime started");
  }

  async #stopClaude(): Promise<void> {
    const claude = this.#claude;
    if (!claude) return;
    this.#claude = undefined;
    await Effect.runPromise(Scope.close(claude.scope, Exit.void));
    await this.#closeOrphans((_, item) => kindOf(item) !== BackgroundTaskKind.PROCESS, "worker_restart");
    this.#log("claude runtime stopped");
  }

  async #reconcileCodex(config: AppliedConfig | undefined, key: string | undefined): Promise<void> {
    await this.#stopCodex();
    if (!config || !key) return;
    const home = prepareCodexHome({ dataDir: this.#options.dataDir, linkDeviceLogin: config.codex.linkDeviceLogin, deviceCodexHome: this.#deviceHomes.codex });
    if (home.problem) this.#log(`codex home: ${home.problem}`);
    const profiles = config.profiles.flatMap((p) => (p.resolved && usableBy(p.resolved, "codex") ? [p.resolved] : []));
    const layer = CodexThreads.layer({
      launch: codexAppServerLaunch(profiles, process.env, config.codex.executable, config.nativeTools, home.path),
      clientVersion: this.#options.clientVersion,
      configuredEffort: () => readCodexConfiguredEffort(this.#deviceHomes.codex),
      profile: (id) => profiles.find((p) => p.id === (id || "native")),
      publish: (event) => this.#publish(event),
      interact: (request) => this.#interact(request),
      callTool: (call) => this.#callTool(call),
    });
    const scope = await Effect.runPromise(Scope.make());
    const context = await this.#options.runtime.runPromise(Layer.buildWithScope(layer, scope));
    this.#codex = { key, scope, context };
    this.#log("codex runtime started");
  }

  async #stopCodex(): Promise<void> {
    const codex = this.#codex;
    if (!codex) return;
    this.#codex = undefined;
    await Effect.runPromise(Scope.close(codex.scope, Exit.void));
    await this.#closeOrphans((_, item) => kindOf(item) === BackgroundTaskKind.PROCESS, "worker_restart");
    this.#log("codex runtime stopped");
  }

  /** Ends background tasks the journal has open but no provider process runs any more. */
  async #closeOrphans(match: (threadId: string, item: Item) => boolean, stopReason: string): Promise<number> {
    const open = await this.#options.runtime.runPromise(Journal.use((j) => j.openBackgroundTasks()));
    let closed = 0;
    for (const { threadId, item } of open) {
      if (!match(threadId, item) || item.content.case !== "backgroundTask") continue;
      const ended = clone(ItemSchema, item);
      ended.status = ItemStatus.INTERRUPTED;
      if (ended.content.case === "backgroundTask") ended.content.value.stopReason = stopReason;
      const event = await this.#options.runtime.runPromise(
        Journal.use((j) => j.append(threadId, { body: { case: "itemCompleted", value: { item: ended } } })),
      );
      this.#send({ case: "threadEvent", value: event });
      closed++;
    }
    return closed;
  }

  // ------------------------------------------------------------------ events and interactions

  #publish(event: ThreadEvent): void {
    const key = `${event.threadId}/${event.turnId}`;
    if (event.body.case === "turnStarted") this.#running.add(key);
    if (event.body.case === "turnFinished") {
      this.#running.delete(key);
      if (this.#rebuildWanted && this.#running.size === 0) void this.#reconcileRuntimes();
    }
    this.#send({ case: "threadEvent", value: event });
  }

  #interact(request: InteractionRequest): Promise<InteractionResponse> {
    return new Promise((resolve) => {
      this.#interactions.set(request.requestId, { request, resolve });
      this.#send({ case: "interactionRequest", value: request });
    });
  }

  #callTool(call: AgentToolCall): Promise<AgentToolResult> {
    return new Promise((resolve) => {
      // The same call asked twice (provider retry) shares one gateway round trip.
      const pending = this.#toolCalls.get(call.callId);
      if (pending) {
        const first = pending.resolve;
        pending.resolve = (result) => (first(result), resolve(result));
        return;
      }
      this.#toolCalls.set(call.callId, { call, resolve });
      this.#send({ case: "agentToolCall", value: call });
    });
  }

  #send(payload: Parameters<GatewayLink["send"]>[0]): void {
    try {
      this.#link?.send(payload);
    } catch {
      // Link closed meanwhile: events are in the journal, interactions are re-sent on attach.
    }
  }

  #log(message: string): void {
    this.#options.log?.(message);
  }
}

function kindOf(item: Item): BackgroundTaskKind | undefined {
  return item.content.case === "backgroundTask" ? item.content.value.kind : undefined;
}

function taskOf(item: Item): string | undefined {
  return item.content.case === "backgroundTask" ? item.content.value.taskId : undefined;
}

/** A CLIProxyAPI profile serves the providers it lists (both by default); native profiles serve their own CLI. */
function usableBy(profile: ResolvedProfile, provider: "claude" | "codex"): boolean {
  return profile.kind !== "cliproxyapi" || profile.providers.includes(provider);
}
