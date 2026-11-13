import { ensureScratchDirectory } from "./scratch.ts";
import { join } from "node:path";
import { PermissionMode, Provider, type Command } from "@canopy/contracts";
import { Context, Effect } from "effect";
import { Journal } from "../journal/index.ts";
import { ClaudeThreads } from "../providers/claude/threads.ts";
import type { SteerError } from "../providers/turn-input.ts";

import { CommandError, type CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";
import { instanceKey } from "./instance-runtimes.ts";
import { prepareShellInput } from "./shell-input.ts";
import { workerDiagnostics } from "../diagnostics/worker.ts";
import { connectorTurn } from "./connector-turn.ts";

const TURN_NOT_RUNNING = "TURN_NOT_RUNNING";

export class ThreadCommands {
  readonly #starts = new Map<string, Promise<CommandOutput>>();
  constructor(readonly ctx: HostContext) {}
  async createThread(kind: Extract<Command["kind"], { case: "createThread" }>): Promise<CommandOutput> {
    const spec = kind.value.thread;

    if (!spec) throw new CommandError("INVALID_COMMAND", "thread spec missing", true);

    if (spec.scratch) {
      try {
        ensureScratchDirectory(spec.cwd, join(this.ctx.state.options.dataDir, "scratch"));
      } catch (error) {
        throw new CommandError("SCRATCH_NOT_ALLOWED", error instanceof Error ? error.message : String(error), true);
      }
    }

    this.ctx.ops.checkCwd(spec.cwd);
    this.ctx.state.cwds.set(spec.threadId, spec.cwd);
    void this.ctx.state.heads.track(spec.threadId, spec.cwd);
    this.ctx.state.threadProviders.set(spec.threadId, spec.provider);
    this.ctx.state.threadInstances.set(
      spec.threadId,
      instanceKey(Provider[spec.provider]!.toLowerCase(), spec.providerProfileId),
    );
    const fork = kind.value.fork;

    // A fork point without its provider ref would make both harnesses copy the whole history instead.
    if (fork?.afterTurnId && !fork.afterProviderTurnRef) {
      throw new CommandError("FORK_POINT_UNKNOWN", `turn ${fork.afterTurnId} has no fork point at the provider`, true);
    }

    if (spec.provider === Provider.GROK)
      await this.ctx.ops.runGrok((threads) => threads.create(spec, fork), spec.providerProfileId || "native");
    else if (spec.provider === Provider.CLAUDE)
      await this.ctx.ops.runClaude((threads) => threads.create(spec, fork), spec.providerProfileId || "native");
    else
      await this.ctx.ops.runCodex(
        spec.provider,
        (threads) => threads.create(spec, fork),
        this.ctx.ops.codexGroupOf(spec.providerProfileId),
      );

    return {};
  }

  async startTurn(kind: Extract<Command["kind"], { case: "startTurn" }>, commandId: string): Promise<CommandOutput> {
    const threadId = kind.value.thread?.threadId ?? "";
    const previous = this.#starts.get(threadId);

    const next = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        // The gateway outbox retains this unacknowledged command across restarts/reconnects.
        // Provider wake-ups can precede their turn_started event reaching the gateway.
        while (
          [...this.ctx.state.running].some(
            (key) => key.startsWith(`${threadId}/`) && key !== `${threadId}/${kind.value.turnId}`,
          )
        ) {
          if (this.ctx.state.shuttingDown || this.ctx.state.closing)
            throw new CommandError("WORKER_DRAINING", "worker is stopping", false);
          await Bun.sleep(50);
        }

        if (this.ctx.state.shuttingDown || this.ctx.state.closing)
          throw new CommandError("WORKER_DRAINING", "worker is stopping", false);

        return this.#startTurn(kind, commandId);
      });

    this.#starts.set(threadId, next);

    try {
      return await next;
    } finally {
      if (this.#starts.get(threadId) === next) this.#starts.delete(threadId);
    }
  }

  async #startTurn(kind: Extract<Command["kind"], { case: "startTurn" }>, commandId: string): Promise<CommandOutput> {
    const { thread: spec, turnId, input: rawInput, model, effort, permissionMode } = kind.value;

    if (!spec || !rawInput) throw new CommandError("INVALID_COMMAND", "thread spec or input missing", true);

    // A crash can land between turn_started and remembering CommandResult. Do not admit that turn again,
    // even after its events were ACKed or the gateway replaced a previously rejected command id.
    if (await this.ctx.state.options.runtime.runPromise(Journal.use((j) => j.hasStartedTurn(spec.threadId, turnId))))
      return {};

    if (await this.ctx.state.options.runtime.runPromise(Journal.use((j) => j.wasInterrupted(spec.threadId, turnId))))
      return {};

    if (this.ctx.state.closedThreads.has(spec.threadId))
      throw new CommandError("THREAD_CLOSED", "the thread is archived or deleted", true);

    if (
      (permissionMode || spec.permissionMode) === PermissionMode.FULL_ACCESS &&
      this.ctx.state.options.fullAccess === false
    )
      throw new CommandError("FULL_ACCESS_DISABLED", "Full access is turned off on this computer's worker", true);
    this.ctx.ops.checkCwd(spec.cwd);
    this.ctx.state.cwds.set(spec.threadId, spec.cwd);
    void this.ctx.state.heads.track(spec.threadId, spec.cwd);
    this.ctx.state.threadProviders.set(spec.threadId, spec.provider);
    this.ctx.state.threadInstances.set(
      spec.threadId,
      instanceKey(Provider[spec.provider]!.toLowerCase(), spec.providerProfileId),
    );

    const input = await prepareShellInput(this.ctx, spec.threadId, turnId, rawInput, commandId, true).catch((error) => {
      // Its ordered journal events carry the terminal state; a generic command error would race them.
      if (error instanceof CommandError && error.code === "SHELL_INTERRUPTED") return undefined;
      throw error;
    });

    if (!input) return {};

    // The files first: the input already names their paths.
    if (input.attachments.length > 0) await this.ctx.ops.ensureAttachments(spec.threadId, input.attachments);

    const recoveryContext = await this.ctx.state.options.runtime.runPromise(
      Journal.use((journal) =>
        Effect.gen(function* () {
          if (input.text === "Continue") return yield* journal.recoveryInstructions(spec.threadId);
          yield* journal.rememberRequest(spec.threadId, input.text);

          return "";
        }),
      ),
    );

    // UNSPECIFIED (an older gateway): the thread's mode.
    const connectors = await connectorTurn(this.ctx, spec, turnId);

    const settings = {
      model,
      effort,
      permissionMode: permissionMode || spec.permissionMode,
      recoveryContext,
      ...connectors,
    };

    // An archive/delete interrupt can overtake a queued start or arrive while its files are fetched.
    if (await this.ctx.state.options.runtime.runPromise(Journal.use((j) => j.wasInterrupted(spec.threadId, turnId))))
      return {};

    if (this.ctx.state.closedThreads.has(spec.threadId))
      throw new CommandError("THREAD_CLOSED", "the thread is archived or deleted", true);
    workerDiagnostics.turns.queue(
      spec.threadId,
      turnId,
      spec.provider === Provider.CLAUDE ? "claude" : spec.provider === Provider.GROK ? "grok" : "codex",
    );

    try {
      if (spec.provider === Provider.GROK)
        await this.ctx.ops.runGrok(
          (threads) => threads.startTurn(spec, turnId, input, settings),
          spec.providerProfileId || "native",
        );
      else if (spec.provider === Provider.CLAUDE)
        await this.ctx.ops.runClaude(
          (threads) => threads.startTurn(spec, turnId, input, settings),
          spec.providerProfileId || "native",
        );
      else
        await this.ctx.ops.runCodex(
          spec.provider,
          (threads) => threads.startTurn(spec, turnId, input, settings),
          this.ctx.ops.codexGroupOf(spec.providerProfileId),
        );
    } catch (error) {
      await connectors.failed();
      throw error;
    }

    return {};
  }

  async steerTurn(kind: Extract<Command["kind"], { case: "steerTurn" }>, commandId: string): Promise<CommandOutput> {
    const { threadId, turnId, inputId, input: rawInput } = kind.value;

    if (!rawInput || !inputId) throw new CommandError("INVALID_COMMAND", "input or input_id missing", true);

    if ([...this.ctx.state.grok.values()].some((handle) => handle.runtime.running(threadId)))
      throw new CommandError("STEER_REJECTED", "Grok ACP does not support mid-turn input; queue this message", true);

    if (!this.ctx.state.running.has(`${threadId}/${turnId}`))
      throw new CommandError("STEER_NOT_RUNNING", "the turn is not running on this worker", true);
    const input = await prepareShellInput(this.ctx, threadId, turnId, rawInput, commandId, false);

    // FetchBlob confirms every file's bytes; verify and atomically write them before the harness sees their paths.
    if (input.attachments.length > 0) await this.ctx.ops.ensureAttachments(threadId, input.attachments);

    // File delivery can outlive this turn. Never steer a newer turn with this message.
    if (!this.ctx.state.running.has(`${threadId}/${turnId}`))
      throw new CommandError("STEER_NOT_RUNNING", "the turn ended while its files were arriving", true);

    // Like InterruptTurn: the runtime with the running turn takes it.
    const claude = [...this.ctx.state.claude].find(([, handle]) =>
      Context.get(handle.context, ClaudeThreads).running(threadId),
    );

    const steer = (effect: Effect.Effect<void, SteerError>) =>
      effect.pipe(
        Effect.catchTag("SteerError", (error) => Effect.die(new CommandError(error.code, error.message, true))),
      );

    if ([...this.ctx.state.grok.values()].some((handle) => handle.runtime.running(threadId))) {
      throw new CommandError("STEER_REJECTED", "Grok ACP does not support mid-turn input; queue this message", true);
    } else if (claude) {
      await this.ctx.ops.runClaude(
        (threads) => steer(threads.steer(threadId, turnId, inputId, input)),
        claude[0],
        true,
      );
    } else if (this.ctx.state.codex.size > 0) {
      await this.ctx.ops.runCodex(
        Provider.CODEX,
        (threads) => steer(threads.steer(threadId, turnId, inputId, input)),
        this.ctx.ops.codexGroupWith(threadId),
        true,
      );
    } else {
      throw new CommandError("STEER_NOT_RUNNING", "the turn is not running on this worker", true);
    }

    return {};
  }

  async interruptTurn(kind: Extract<Command["kind"], { case: "interruptTurn" }>): Promise<CommandOutput> {
    const { threadId, turnId } = kind.value;

    const shellRuns = [...this.ctx.state.shellRuns.values()].filter(
      (r) => r.threadId === threadId && r.turnId === turnId,
    );

    for (const run of shellRuns) run.controller.abort();

    if (shellRuns.length > 0) {
      await Promise.allSettled(shellRuns.map((r) => r.pending));

      if (shellRuns.some((run) => run.startTurn)) return {};
    }

    // Also fences StartTurn still waiting in admission; the cancellation survives worker restart.
    await this.ctx.state.options.runtime.runPromise(Journal.use((j) => j.noteInterrupt(threadId, turnId)));

    // E.g. the turn died with the previous process: the gateway ends it on its side.
    if (!this.ctx.state.running.has(`${threadId}/${turnId}`))
      throw new CommandError(TURN_NOT_RUNNING, "the turn is not running on this worker", true);

    // The command does not name the provider: the runtime with the running turn takes it.
    const claude = [...this.ctx.state.claude].find(([, handle]) =>
      Context.get(handle.context, ClaudeThreads).running(threadId),
    );

    const grok = [...this.ctx.state.grok].find(([, handle]) => handle.runtime.running(threadId));

    if (grok) {
      await this.ctx.ops.runGrok((threads) => threads.interrupt(threadId, turnId), grok[0], true);
    } else if (claude) {
      await this.ctx.ops.runClaude((threads) => threads.interrupt(threadId, turnId), claude[0], true);
    } else {
      await this.ctx.ops.runCodex(
        Provider.CODEX,
        (threads) => threads.interrupt(threadId, turnId),
        this.ctx.ops.codexGroupWith(threadId),
        true,
      );
    }

    return {};
  }
}
