import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MessageInitShape } from "@bufbuild/protobuf";
import {
  Provider,
  type Command,
  type DirectoryEntrySchema,
  type CommandResultSchema,
  type ConfigAppliedSchema,
  type InteractionRequest,
  type InteractionResponse,
  type ThreadEvent,
  type WorkerConfig,
} from "@open-agents/contracts";
import { Cause, Context, Effect, Exit, Layer, Scope, type ManagedRuntime } from "effect";
import { applyWorkerConfig, isAllowedPath, type AppliedConfig, type DeviceProbe, systemProbe } from "../config/remote.ts";
import type { GatewayLink } from "../gateway-link/index.ts";
import { Journal } from "../journal/index.ts";
import { prepareCodexHome } from "../providers/codex/home.ts";
import { codexAppServerLaunch } from "../providers/codex/launch.ts";
import { CodexThreads } from "../providers/codex/threads.ts";

/**
 * Everything the worker does between the gateway link and the provider runtimes
 * (docs/worker-config.md, docs/codex-adapter.md). Used by main.ts and by integration tests.
 *
 * - Remote config: validated, applied; the Codex runtime is rebuilt when its settings change,
 *   but never under a running turn (deferred until the worker is idle).
 * - Commands: answered once; final results are remembered in the journal for redelivery.
 * - Events: journal first (inside the runtimes), then sent when the link is up.
 * - Interactions: forwarded to the gateway, re-sent after reconnect until answered.
 */

type CommandResultInit = MessageInitShape<typeof CommandResultSchema>;
type ConfigAppliedInit = MessageInitShape<typeof ConfigAppliedSchema>;
type DirectoryEntryInit = MessageInitShape<typeof DirectoryEntrySchema>;
interface CommandOutput {
  readonly entries?: DirectoryEntryInit[];
}

export interface WorkerHostOptions {
  readonly runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
  readonly dataDir: string;
  readonly clientVersion: string;
  readonly probe?: DeviceProbe;
  readonly log?: (message: string) => void;
}

interface CodexRuntime {
  readonly key: string;
  readonly scope: Scope.Closeable;
  readonly context: Context.Context<CodexThreads>;
}

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
  #codex: CodexRuntime | undefined;
  #rebuildWanted = false;
  readonly #running = new Set<string>();
  readonly #interactions = new Map<string, { request: InteractionRequest; resolve: (r: InteractionResponse) => void }>();

  constructor(options: WorkerHostOptions) {
    this.#options = options;
  }

  get config(): AppliedConfig | undefined {
    return this.#config;
  }

  attach(link: GatewayLink): void {
    this.#link = link;
    for (const { request } of this.#interactions.values()) this.#send({ case: "interactionRequest", value: request });
  }

  detach(link: GatewayLink): void {
    if (this.#link === link) this.#link = undefined;
  }

  async applyConfig(message: WorkerConfig): Promise<ConfigAppliedInit> {
    const result = applyWorkerConfig(message, this.#options.probe ?? systemProbe);
    if (result.applied) {
      this.#config = result.config;
      await this.#reconcileCodex();
    }
    return result.report;
  }

  handleInteractionResponse(response: InteractionResponse): void {
    const pending = this.#interactions.get(response.requestId);
    if (!pending) return;
    this.#interactions.delete(response.requestId);
    pending.resolve(response);
  }

  async handleCommand(command: Command): Promise<CommandResultInit> {
    const known = await this.#options.runtime.runPromise(Journal.use((j) => j.commandResult(command.commandId)));
    if (known) return known;
    try {
      const output = await this.#execute(command);
      const result: CommandResultInit = { commandId: command.commandId, ok: true, ...(output.entries && { entries: output.entries }) };
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
        await this.#runCodex(spec.provider, (threads) => threads.create(spec, kind.value.fork));
        return {};
      }
      case "startTurn": {
        const { thread: spec, turnId, input } = kind.value;
        if (!spec || !input) throw new CommandError("INVALID_COMMAND", "thread spec or input missing", true);
        await this.#runCodex(spec.provider, (threads) => threads.startTurn(spec, turnId, input));
        return {};
      }
      case "interruptTurn":
        await this.#runCodex(Provider.CODEX, (threads) => threads.interrupt(kind.value.threadId, kind.value.turnId));
        return {};
      case "unloadThread":
        return {}; // nothing to free yet: Codex threads share one app-server process
      default:
        throw new CommandError("UNIMPLEMENTED", `${kind.case ?? "empty"} is not supported by this worker yet`, true);
    }
  }

  async #runCodex<A, E>(provider: Provider, use: (threads: CodexThreads["Service"]) => Effect.Effect<A, E>): Promise<A> {
    if (provider !== Provider.CODEX) throw new CommandError("PROVIDER_UNAVAILABLE", `${Provider[provider]} is not supported by this worker yet`, true);
    if (!this.#codex) throw new CommandError("PROVIDER_UNAVAILABLE", this.#config?.codex.problem ?? "codex is disabled", false);
    const exit = await this.#options.runtime.runPromiseExit(Effect.provide(CodexThreads.use(use), this.#codex.context));
    if (Exit.isSuccess(exit)) return exit.value;
    const error = Cause.squash(exit.cause);
    throw new CommandError("THREAD_ERROR", error instanceof Error || (error && typeof error === "object" && "message" in error) ? String((error as { message: unknown }).message) : String(error), true);
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

  async #reconcileCodex(): Promise<void> {
    const config = this.#config;
    const key = config ? this.#codexKey(config) : undefined;
    if (key === this.#codex?.key) return;
    if (this.#running.size > 0) {
      this.#rebuildWanted = true; // never under a running turn
      this.#log(`codex settings changed; restart deferred until ${this.#running.size} running turn(s) finish`);
      return;
    }
    this.#rebuildWanted = false;
    await this.#stopCodex();
    if (!config || !key) return;
    const home = prepareCodexHome({ dataDir: this.#options.dataDir, linkDeviceLogin: config.codex.linkDeviceLogin });
    if (home.problem) this.#log(`codex home: ${home.problem}`);
    const profiles = config.profiles.flatMap((p) => (p.resolved ? [p.resolved] : []));
    const layer = CodexThreads.layer({
      launch: codexAppServerLaunch(profiles, process.env, config.codex.executable, config.nativeTools, home.path),
      clientVersion: this.#options.clientVersion,
      profile: (id) => profiles.find((p) => p.id === (id || "native")),
      publish: (event) => this.#publish(event),
      interact: (request) => this.#interact(request),
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
    this.#log("codex runtime stopped");
  }

  // ------------------------------------------------------------------ events and interactions

  #publish(event: ThreadEvent): void {
    const key = `${event.threadId}/${event.turnId}`;
    if (event.body.case === "turnStarted") this.#running.add(key);
    if (event.body.case === "turnFinished") {
      this.#running.delete(key);
      if (this.#rebuildWanted && this.#running.size === 0) void this.#reconcileCodex();
    }
    this.#send({ case: "threadEvent", value: event });
  }

  #interact(request: InteractionRequest): Promise<InteractionResponse> {
    return new Promise((resolve) => {
      this.#interactions.set(request.requestId, { request, resolve });
      this.#send({ case: "interactionRequest", value: request });
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
