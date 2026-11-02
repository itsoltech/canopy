import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { clone, create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import {
  BackgroundTaskKind,
  ItemSchema,
  ItemStatus,
  Provider,
  type AgentToolCall,
  type AgentToolResult,
  type BlobChunk,
  type InputAttachment,
  type Command,
  type DirectoryEntrySchema,
  type CommandResultSchema,
  ConfigAppliedSchema,
  type InteractionRequest,
  type InteractionResponse,
  type Item,
  type ProfileModelsSchema,
  type ThreadEvent,
  type WorkerConfig,
  TurnOutcome,
} from "@open-agents/contracts";
import { Cause, Context, Effect, Exit, Layer, Scope, type ManagedRuntime } from "effect";
import { applyWorkerConfig, instanceShadowHome, isAllowedPath, type AppliedConfig, type DeviceHomes, type DeviceProbe, systemProbe } from "../config/remote.ts";
import type { GatewayLink } from "../gateway-link/index.ts";
import { Journal } from "../journal/index.ts";
import { deviceClaudeHome, prepareClaudeHome } from "../providers/claude/home.ts";
import { claudeExtraArgs, ClaudeThreads, type ClaudeInstanceRuntime } from "../providers/claude/threads.ts";
import { deviceCodexHome, prepareCodexHome } from "../providers/codex/home.ts";
import { codexAppServerLaunch } from "../providers/codex/launch.ts";
import { startCodexDeviceLogin } from "../providers/codex/login.ts";
import { CodexThreads } from "../providers/codex/threads.ts";
import { claudeConfiguredEffort, readClaudeUserSettings, readCodexConfiguredEffort } from "../providers/default-effort.ts";
import { hasOwnRuntime, providersOf, type ProfileRuntimeConfig, type ResolvedProfile } from "../providers/profiles.ts";
import { reconcileTurn, WORKER_RESTARTED } from "../providers/reconcile.ts";
import { AttachmentError, AttachmentFiles } from "../attachments/files.ts";
import { ImageError, PreviewStore, viewImage, type ViewImageResult } from "../images/index.ts";
import type { SteerError } from "../providers/turn-input.ts";

/**
 * Everything the worker does between the gateway link and the provider runtimes
 * (docs/worker-config.md, docs/codex-adapter.md). Used by main.ts and by integration tests.
 *
 * - Remote config: validated, applied; provider runtimes are rebuilt when their settings change,
 *   but never under a running turn (deferred until the worker is idle). Codex runs one shared app-server for
 *   the profiles without environment variables and one per profile with its own variables (they belong to the
 *   process); only the processes whose settings changed restart.
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
 * - Attachments (docs/protocol.md, "Załączniki"): a turn's files are fetched from the gateway (FetchBlob) into
 *   `<data_dir>/attachments/<thread>/<attachment>/` before the harness gets the turn.
 * - Images (docs/agent-bus.md, "view_image"): view_image runs here; every image a model saw gets a preview, sent
 *   to the gateway (BlobChunk) right before the event that shows it.
 */

type CommandResultInit = MessageInitShape<typeof CommandResultSchema>;
type ConfigAppliedInit = MessageInitShape<typeof ConfigAppliedSchema>;
type DirectoryEntryInit = MessageInitShape<typeof DirectoryEntrySchema>;
type ProfileModelsInit = MessageInitShape<typeof ProfileModelsSchema>;
interface CommandOutput {
  readonly entries?: DirectoryEntryInit[];
  readonly models?: ProfileModelsInit[];
  readonly login?: { verificationUrl: string; userCode: string; loginId: string };
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

/** How long the gateway may take to hand over one attachment. */
const FETCH_TIMEOUT_MS = 120_000;

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
  /** The configuration as received: checked again on ProbeProviders and after a login from the app. */
  #received: WorkerConfig | undefined;
  /** Sign-ins from the app in progress, by provider/profile. */
  readonly #logins = new Map<string, Promise<unknown>>();
  #link: GatewayLink | undefined;
  /** Codex runtimes by group (SHARED_CODEX, or one per profile with its own variables). */
  readonly #codex = new Map<string, ProviderRuntimeHandle<CodexThreads>>();
  #claude: ProviderRuntimeHandle<ClaudeThreads> | undefined;
  #rebuildWanted = false;
  readonly #codexRestart = new Map<string, Promise<void>>();
  readonly #running = new Set<string>();
  readonly #interactions = new Map<string, { request: InteractionRequest; resolve: (r: InteractionResponse) => void }>();
  readonly #toolCalls = new Map<string, { call: AgentToolCall; resolve: (r: AgentToolResult) => void }>();
  /** Last model catalog (ModelCatalog), re-sent after a reconnect. */
  #catalog: { configVersion: bigint; profiles: ProfileModelsInit[] } | undefined;
  #catalogRun = 0;
  /** Taken at start: the Claude runtime points this process's CLAUDE_CONFIG_DIR at the isolated home. */
  readonly #deviceHomes: { readonly claude: string; readonly codex: string };
  readonly #files: AttachmentFiles;
  readonly #previews: PreviewStore;
  /** Working directory per thread (from the commands' ThreadSpec): view_image's scope. */
  readonly #cwds = new Map<string, string>();
  /** Attachments being fetched (FetchBlob), by request id. */
  readonly #fetches = new Map<string, { chunks: Uint8Array[]; resolve: (data: Uint8Array) => void; reject: (error: Error) => void }>();

  constructor(options: WorkerHostOptions) {
    this.#options = options;
    this.#deviceHomes = options.deviceHomes ?? { claude: deviceClaudeHome(process.env), codex: deviceCodexHome(process.env) };
    this.#files = new AttachmentFiles(options.dataDir);
    this.#previews = new PreviewStore(options.dataDir);
    this.#previews.prune();
  }

  /** Hello.attachments_root. */
  get attachmentsRoot(): string {
    return this.#files.root;
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
    // The redelivered StartTurn asks again on the next link.
    for (const [id, fetch] of this.#fetches) {
      this.#fetches.delete(id);
      fetch.reject(new AttachmentError("the gateway link closed while an attachment was on its way", false));
    }
  }

  /** A chunk of an attachment the worker asked for (FetchBlob). */
  handleBlobChunk(chunk: BlobChunk): void {
    const fetch = this.#fetches.get(chunk.requestId);
    if (!fetch) return;
    if (chunk.error) {
      this.#fetches.delete(chunk.requestId);
      fetch.reject(new AttachmentError(`the gateway could not hand over the attachment: ${chunk.error}`, true));
      return;
    }
    fetch.chunks.push(chunk.data);
    if (!chunk.last) return;
    this.#fetches.delete(chunk.requestId);
    fetch.resolve(new Uint8Array(Buffer.concat(fetch.chunks)));
  }

  /** Previews an event points to, sent on `link` before the event (journal resend after Welcome). */
  sendPreviews(link: GatewayLink, event: ThreadEvent): void {
    this.#previews.sendFor(link, event, (chunk) => link.send({ case: "blobChunk", value: chunk }));
  }

  async applyConfig(message: WorkerConfig): Promise<ConfigAppliedInit> {
    const result = applyWorkerConfig(message, this.#options.probe ?? systemProbe, this.#homes());
    if (result.applied) {
      this.#received = message;
      this.#config = result.config;
      await this.#reconcileRuntimes();
      void this.#publishCatalog(message.version);
    }
    return result.report;
  }

  /** Where instances live on this device (shadow homes, the device owner's logins). */
  #homes(): DeviceHomes {
    return { dataDir: this.#options.dataDir, claude: this.#deviceHomes.claude, codex: this.#deviceHomes.codex, env: process.env };
  }

  /**
   * The current configuration checked again (versions, availability, logins: ProbeProviders, a finished sign-in):
   * a new ConfigApplied for the same version, then the model catalog.
   */
  async #probe(): Promise<void> {
    const received = this.#received;
    if (!received) throw new CommandError("WORKER_NOT_CONFIGURED", "the worker has no configuration yet", false);
    const report = await this.applyConfig(received);
    this.#send({ case: "configApplied", value: create(ConfigAppliedSchema, report) });
  }

  /** Codex sign-in from the app for an instance with its own login (device code); finishes in the background. */
  async #startLogin(provider: Provider, profileId: string): Promise<NonNullable<CommandOutput["login"]>> {
    const config = this.#config;
    if (!config) throw new CommandError("WORKER_NOT_CONFIGURED", "the worker has no configuration yet", false);
    if (provider !== Provider.CODEX) throw new CommandError("UNSUPPORTED", "only Codex signs in from the app", true);
    const status = config.profiles.find((p) => p.config.id === (profileId || "native") && providersOf(p.config).includes("codex"));
    if (!status) throw new CommandError("UNKNOWN_PROFILE", `unknown provider instance codex/${profileId}`, true);
    const runtime = status.config.runtime ?? {};
    if (status.config.kind !== "native" || !runtime.ownLogin) throw new CommandError("UNSUPPORTED", "only an instance with its own login signs in from the app", true);
    if (!config.codex.enabled || !config.codex.executable) throw new CommandError("PROVIDER_UNAVAILABLE", config.codex.problem ?? "codex is disabled", false);
    const home = prepareCodexHome({ dataDir: this.#options.dataDir, path: instanceShadowHome(this.#options.dataDir, "codex", status.config.id, runtime)!, ownLogin: true, linkDeviceLogin: false });
    const env = Object.fromEntries((status.config.env ?? []).map((v) => [v.name, v.value]));
    const login = await startCodexDeviceLogin({
      launch: codexAppServerLaunch([], process.env, runtime.executablePath || config.codex.executable, config.nativeTools, home.path, env),
      clientVersion: this.#options.clientVersion,
    }).catch((error: unknown) => {
      throw new CommandError("LOGIN_FAILED", error instanceof Error ? error.message : String(error), false);
    });
    const key = `codex/${status.config.id}`;
    const done = login.done.then(async (outcome) => {
      this.#log(`codex sign-in of ${status.config.id}: ${outcome.success ? "signed in" : (outcome.error ?? "failed")}`);
      this.#logins.delete(key);
      // The new login shows in the report; Codex processes of the instance pick it up when they restart.
      await this.#probe().catch(() => {});
    });
    this.#logins.set(key, done);
    return { verificationUrl: login.verificationUrl, userCode: login.userCode, loginId: login.loginId };
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
      if (this.#codex.size > 0 && usableBy(resolved, "codex") && (!provider || provider === Provider.CODEX)) pairs.push({ provider: Provider.CODEX, profile: resolved.id });
    }
    return Promise.all(
      pairs.map(async ({ provider: p, profile }): Promise<ProfileModelsInit> => {
        try {
          const listed: { models: ProfileModelsInit["models"]; detail?: string } =
            p === Provider.CLAUDE
              ? await this.#runClaude((threads) => threads.listModels(profile))
              : await this.#runCodex(Provider.CODEX, (threads) => threads.listModels(profile), this.#codexGroupOf(profile));
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
        ...(output.login && { login: output.login }),
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
    for (const group of [...this.#codex.keys()]) await this.#stopCodex(group);
    await this.#closeCodexOrphans();
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
      for (const event of events) this.#sendEvent(event);
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
        this.#cwds.set(spec.threadId, spec.cwd);
        const fork = kind.value.fork;
        if (spec.provider === Provider.CLAUDE) await this.#runClaude((threads) => threads.create(spec, fork));
        else await this.#runCodex(spec.provider, (threads) => threads.create(spec, fork), this.#codexGroupOf(spec.providerProfileId));
        return {};
      }
      case "startTurn": {
        const { thread: spec, turnId, input, model, effort, permissionMode } = kind.value;
        if (!spec || !input) throw new CommandError("INVALID_COMMAND", "thread spec or input missing", true);
        this.#cwds.set(spec.threadId, spec.cwd);
        // The files first: the input already names their paths.
        if (input.attachments.length > 0) await this.#ensureAttachments(spec.threadId, input.attachments);
        // UNSPECIFIED (an older gateway): the thread's mode.
        const settings = { model, effort, permissionMode: permissionMode || spec.permissionMode };
        if (spec.provider === Provider.CLAUDE) await this.#runClaude((threads) => threads.startTurn(spec, turnId, input, settings));
        else await this.#runCodex(spec.provider, (threads) => threads.startTurn(spec, turnId, input, settings), this.#codexGroupOf(spec.providerProfileId));
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
        } else if (this.#codex.size > 0) {
          await this.#runCodex(Provider.CODEX, (threads) => steer(threads.steer(threadId, turnId, inputId, input)), this.#codexGroupWith(threadId));
        } else {
          throw new CommandError("STEER_NOT_RUNNING", "the turn is not running on this worker", true);
        }
        return {};
      }
      case "listModels":
        return { models: await this.#listModels(kind.value.provider, kind.value.profileId) };
      case "probeProviders":
        await this.#probe();
        return {};
      case "startLogin":
        return { login: await this.#startLogin(kind.value.provider, kind.value.profileId) };
      case "interruptTurn": {
        const { threadId, turnId } = kind.value;
        // E.g. the turn died with the previous process: the gateway ends it on its side.
        if (!this.#running.has(`${threadId}/${turnId}`)) throw new CommandError(TURN_NOT_RUNNING, "the turn is not running on this worker", true);
        // Remembered with the turn: if it ends without the worker seeing it, its interruption was asked for.
        await this.#options.runtime.runPromise(Journal.use((j) => j.noteInterrupt(threadId, turnId)));
        // The command does not name the provider: the runtime with the running turn takes it.
        const claude = this.#claude;
        if (claude && Context.get(claude.context, ClaudeThreads).running(threadId)) {
          await this.#runClaude((threads) => threads.interrupt(threadId, turnId));
        } else {
          await this.#runCodex(Provider.CODEX, (threads) => threads.interrupt(threadId, turnId), this.#codexGroupWith(threadId));
        }
        return {};
      }
      case "setGoal": {
        const { thread: spec, directive, objective, nativeTokenBudget } = kind.value;
        if (!spec) throw new CommandError("INVALID_COMMAND", "thread spec missing", true);
        // Claude goals are /goal turns in the input stream (docs/goals.md); the gateway queues them as turns.
        if (spec.provider === Provider.CLAUDE) throw new CommandError("UNSUPPORTED", "Claude goals are set with /goal turns", true);
        await this.#runCodex(spec.provider, (threads) => threads.setGoal(spec, directive, objective, nativeTokenBudget), this.#codexGroupOf(spec.providerProfileId));
        return {};
      }
      case "stopTask": {
        const { threadId, taskId } = kind.value;
        const claude = this.#claude && Context.get(this.#claude.context, ClaudeThreads);
        const codexGroup = [...this.#codex].find(([, codex]) => Context.get(codex.context, CodexThreads).backgroundTasks().get(threadId)?.includes(taskId))?.[0];
        if (claude?.backgroundTasks().get(threadId)?.includes(taskId)) await this.#runClaude((threads) => threads.stopTask(threadId, taskId));
        else if (codexGroup !== undefined) await this.#runCodex(Provider.CODEX, (threads) => threads.stopTask(threadId, taskId), codexGroup);
        // No process runs it: if the journal still has it open, its process is gone, so it ends here.
        else await this.#closeOrphans((threadOf, item) => threadOf === threadId && taskOf(item) === taskId, "stopped_by_user");
        return {};
      }
      case "unloadThread":
        return {}; // nothing to free yet: Codex threads share their group's app-server process, Claude turns end with their query
      default:
        throw new CommandError("UNIMPLEMENTED", `${kind.case ?? "empty"} is not supported by this worker yet`, true);
    }
  }

  async #runCodex<A, E>(provider: Provider, use: (threads: CodexThreads["Service"]) => Effect.Effect<A, E>, group: string): Promise<A> {
    if (provider !== Provider.CODEX) throw new CommandError("PROVIDER_UNAVAILABLE", `${Provider[provider]} is not supported by this worker yet`, true);
    await this.#restartFailedCodex(group);
    const codex = this.#codex.get(group);
    if (!codex) throw new CommandError("PROVIDER_UNAVAILABLE", this.#config?.codex.problem ?? "codex is disabled", false);
    return this.#runIn(Effect.provide(CodexThreads.use(use), codex.context));
  }

  /** The Codex process for a profile: its own when it has variables, else the shared one. */
  #codexGroupOf(profileId: string): string {
    const group = codexProfileGroup(profileId || "native");
    return this.#codex.has(group) ? group : SHARED_CODEX;
  }

  /** The Codex process that has the thread loaded (it runs the thread's turn), else the shared one. */
  #codexGroupWith(threadId: string): string {
    return [...this.#codex].find(([, codex]) => Context.get(codex.context, CodexThreads).has(threadId))?.[0] ?? SHARED_CODEX;
  }

  /**
   * The app-server exited on its own (its turns are already settled from their rollouts): the next command gets a
   * new one. Threads resume in it (thread/resume), so they stay usable.
   */
  async #restartFailedCodex(group: string): Promise<void> {
    const codex = this.#codex.get(group);
    const failure = codex && Context.get(codex.context, CodexThreads).failure();
    if (!failure) return;
    let restart = this.#codexRestart.get(group);
    if (!restart) {
      restart = (async () => {
        this.#log(`${failure}; starting a new one`);
        await this.#stopCodex(group);
        await this.#closeCodexOrphans();
        const wanted = this.#config ? this.#codexGroups(this.#config).get(group) : undefined;
        if (wanted) await this.#startCodex(group, wanted);
      })().finally(() => this.#codexRestart.delete(group));
      this.#codexRestart.set(group, restart);
    }
    await restart;
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

  /** Wanted Codex processes: the shared one, and one per usable profile with its own variables. */
  #codexGroups(config: AppliedConfig): Map<string, CodexGroup> {
    const groups = new Map<string, CodexGroup>();
    if (!config.codex.enabled || !config.codex.executable) return groups;
    const usable = config.profiles.flatMap((p) => (p.resolved && usableBy(p.resolved, "codex") ? [p.resolved] : []));
    const group = (profiles: ResolvedProfile[], env: Readonly<Record<string, string>>, runtime: ProfileRuntimeConfig, id?: string): CodexGroup => ({
      profiles,
      env,
      runtime,
      ...(id !== undefined && { id }),
      key: JSON.stringify({
        executable: config.codex.executable,
        linkDeviceLogin: config.codex.linkDeviceLogin,
        nativeTools: config.nativeTools,
        profiles,
      }),
    });
    // The shared process always runs: threads of an unknown or unavailable profile get its error from it.
    // Variables and an own runtime (executable, homes, arguments) belong to a process: such an instance gets its own.
    const own = (p: ResolvedProfile) => hasEnv(p) || hasOwnRuntime(p.runtime ?? {});
    groups.set(SHARED_CODEX, group(usable.filter((p) => !own(p)), {}, {}));
    for (const profile of usable.filter(own)) groups.set(codexProfileGroup(profile.id), group([profile], profile.env, profile.runtime ?? {}, profile.id));
    return groups;
  }

  /** Provider runtimes follow the configuration, but are never rebuilt under a running turn. */
  async #reconcileRuntimes(): Promise<void> {
    const config = this.#config;
    const codexGroups = config ? this.#codexGroups(config) : new Map<string, CodexGroup>();
    const claudeKey = config ? this.#claudeKey(config) : undefined;
    const codexChanged =
      codexGroups.size !== this.#codex.size || [...codexGroups].some(([name, group]) => this.#codex.get(name)?.key !== group.key);
    if (!codexChanged && claudeKey === this.#claude?.key) return;
    if (this.#running.size > 0) {
      this.#rebuildWanted = true;
      this.#log(`provider settings changed; restart deferred until ${this.#running.size} running turn(s) finish`);
      return;
    }
    this.#rebuildWanted = false;
    if (codexChanged) {
      // Only the processes whose settings changed restart; their threads resume in the new ones.
      for (const name of [...this.#codex.keys()]) {
        if (this.#codex.get(name)?.key !== codexGroups.get(name)?.key) await this.#stopCodex(name);
      }
      await this.#closeCodexOrphans();
      for (const [name, group] of codexGroups) if (!this.#codex.has(name)) await this.#startCodex(name, group);
    }
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
    // Instances with their own runtime: their config dir (own login or login source), executable and flags.
    const runtimes = new Map<string, ClaudeInstanceRuntime>();
    for (const profile of profiles) {
      const runtime = profile.runtime ?? {};
      if (!hasOwnRuntime(runtime)) continue;
      const shadow = instanceShadowHome(this.#options.dataDir, "claude", profile.id, runtime);
      const own = shadow
        ? prepareClaudeHome({
            dataDir: this.#options.dataDir,
            path: shadow,
            ...(runtime.ownLogin && { ownLogin: true }),
            linkDeviceLogin: config.claude.linkDeviceLogin,
            deviceClaudeHome: runtime.homePath || this.#deviceHomes.claude,
          })
        : home;
      if (own.problem) this.#log(`claude home of ${profile.id}: ${own.problem}`);
      const executable = runtime.executablePath || config.claude.executable;
      runtimes.set(profile.id, { home: own.path, ...(executable && { executable }), extraArgs: claudeExtraArgs(runtime.launchArgs ?? []) });
    }
    const layer = ClaudeThreads.layer({
      home: home.path,
      ...(config.claude.executable && { executable: config.claude.executable }),
      runtimeOf: (profile) => runtimes.get(profile.id),
      nativeTools: config.nativeTools,
      baseEnv: process.env,
      configuredEffort: (names) => claudeConfiguredEffort(readClaudeUserSettings(this.#deviceHomes.claude), process.env, names),
      profile: (id) => profiles.find((p) => p.id === (id || "native")),
      publish: (event) => this.#publish(event),
      interact: (request) => this.#interact(request),
      callTool: (call) => this.#callTool(call),
      attachmentsDir: (threadId) => this.#files.threadDir(threadId),
      viewImage: (threadId, cwd, path) => this.#viewImage(threadId, cwd, path),
      enrich: (init) => this.#previews.enrich(init),
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

  async #startCodex(name: string, group: CodexGroup): Promise<void> {
    const config = this.#config;
    if (!config) return;
    const { profiles, runtime } = group;
    const shadow = group.id !== undefined ? instanceShadowHome(this.#options.dataDir, "codex", group.id, runtime) : undefined;
    const deviceHome = runtime.homePath || this.#deviceHomes.codex;
    const home = prepareCodexHome({
      dataDir: this.#options.dataDir,
      ...(shadow && { path: shadow }),
      ...(runtime.ownLogin && { ownLogin: true }),
      linkDeviceLogin: config.codex.linkDeviceLogin,
      deviceCodexHome: deviceHome,
    });
    if (home.problem) this.#log(`codex home: ${home.problem}`);
    const layer = CodexThreads.layer({
      launch: codexAppServerLaunch(profiles, process.env, runtime.executablePath || config.codex.executable, config.nativeTools, home.path, group.env, runtime.launchArgs),
      clientVersion: this.#options.clientVersion,
      configuredEffort: () => readCodexConfiguredEffort(deviceHome),
      profile: (id) => profiles.find((p) => p.id === (id || "native")),
      publish: (event) => this.#publish(event),
      interact: (request) => this.#interact(request),
      callTool: (call) => this.#callTool(call),
      viewImage: (threadId, path) => this.#viewImage(threadId, this.#cwds.get(threadId) ?? "", path),
      enrich: (init) => this.#previews.enrich(init),
    });
    const scope = await Effect.runPromise(Scope.make());
    const context = await this.#options.runtime.runPromise(Layer.buildWithScope(layer, scope));
    this.#codex.set(name, { key: group.key, scope, context });
    this.#log(`codex runtime started${name === SHARED_CODEX ? "" : ` (${name})`}`);
  }

  async #stopCodex(name: string): Promise<void> {
    const codex = this.#codex.get(name);
    if (!codex) return;
    this.#codex.delete(name);
    await Effect.runPromise(Scope.close(codex.scope, Exit.void));
    this.#log(`codex runtime stopped${name === SHARED_CODEX ? "" : ` (${name})`}`);
  }

  /** Codex background processes the journal has open that no running Codex process holds any more. */
  async #closeCodexOrphans(): Promise<void> {
    const held = (threadId: string, item: Item) =>
      [...this.#codex.values()].some((codex) => Context.get(codex.context, CodexThreads).backgroundTasks().get(threadId)?.includes(taskOf(item) ?? ""));
    await this.#closeOrphans((threadId, item) => kindOf(item) === BackgroundTaskKind.PROCESS && !held(threadId, item), "worker_restart");
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
      this.#sendEvent(event);
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
    this.#sendEvent(event);
  }

  #sendEvent(event: ThreadEvent): void {
    const link = this.#link;
    if (!link) return; // journaled: resent (with its previews) after the next Welcome
    try {
      this.sendPreviews(link, event);
    } catch {
      // link closed meanwhile
    }
    this.#send({ case: "threadEvent", value: event });
  }

  // ------------------------------------------------------------------ attachments and images

  async #ensureAttachments(threadId: string, attachments: readonly InputAttachment[]): Promise<void> {
    try {
      await this.#files.ensure(threadId, attachments, (sha256) => this.#fetchBlob(threadId, sha256));
    } catch (error) {
      if (error instanceof AttachmentError) throw new CommandError("ATTACHMENT_UNAVAILABLE", error.message, error.final);
      throw new CommandError("ATTACHMENT_UNAVAILABLE", `attachments could not be written: ${error instanceof Error ? error.message : String(error)}`, false);
    }
  }

  #fetchBlob(threadId: string, sha256: string): Promise<Uint8Array> {
    const link = this.#link;
    if (!link) return Promise.reject(new AttachmentError("not connected to the gateway", false));
    const requestId = Bun.randomUUIDv7();
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fetches.delete(requestId);
        reject(new AttachmentError("the gateway did not hand over the attachment in time", false));
      }, FETCH_TIMEOUT_MS);
      this.#fetches.set(requestId, {
        chunks: [],
        resolve: (data) => (clearTimeout(timer), resolve(data)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      try {
        link.send({ case: "fetchBlob", value: { requestId, threadId, sha256 } });
      } catch {
        this.#fetches.delete(requestId);
        clearTimeout(timer);
        reject(new AttachmentError("the gateway link closed", false));
      }
    });
  }

  /** view_image: an image from the thread's working directory or attachments, scaled for any model. */
  async #viewImage(threadId: string, cwd: string, path: string): Promise<ViewImageResult> {
    try {
      if (!cwd) return { ok: false, message: "view_image: the thread's working directory is not known on this worker yet" };
      const image = await viewImage(path, { cwd, roots: [cwd, this.#files.threadDir(threadId)] });
      const scaled = image.width !== image.originalWidth || image.height !== image.originalHeight;
      return {
        ok: true,
        base64: Buffer.from(image.data).toString("base64"),
        mimeType: image.mimeType,
        summary: `${image.path}: ${image.originalWidth}×${image.originalHeight} px${scaled ? `, shown at ${image.width}×${image.height}` : ""} (${image.mimeType}).`,
      };
    } catch (error) {
      return { ok: false, message: `view_image: ${error instanceof ImageError ? error.message : `the image could not be read (${error instanceof Error ? error.message : String(error)})`}` };
    }
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

/** A profile serves the providers it lists (both by default). */
function usableBy(profile: ResolvedProfile, provider: "claude" | "codex"): boolean {
  return profile.providers.includes(provider);
}

/** The Codex process for profiles without their own variables. */
const SHARED_CODEX = "shared";

interface CodexGroup {
  /** Settings of the process: a change restarts it. */
  readonly key: string;
  readonly profiles: ResolvedProfile[];
  /** Variables of the process (a profile's own). */
  readonly env: Readonly<Record<string, string>>;
  /** The instance's own runtime (executable, homes, launch arguments); empty for the shared process. */
  readonly runtime: ProfileRuntimeConfig;
  /** The instance a process of its own serves. */
  readonly id?: string;
}

function codexProfileGroup(profileId: string): string {
  return `profile:${profileId}`;
}

function hasEnv(profile: ResolvedProfile): boolean {
  return Object.keys(profile.env).length > 0;
}
