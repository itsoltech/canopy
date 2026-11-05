import { ensureScratchDirectory } from "./scratch.ts";
import { join } from "node:path";
import { Provider, type Command } from "@canopy/contracts";
import { Context, Effect } from "effect";
import { Journal } from "../journal/index.ts";
import { ClaudeThreads } from "../providers/claude/threads.ts";
import type { SteerError } from "../providers/turn-input.ts";

import { CommandError, type CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";
import { instanceKey } from "./instance-runtimes.ts";
import { prepareShellInput } from "./shell-input.ts";

const TURN_NOT_RUNNING = "TURN_NOT_RUNNING";

export class ThreadCommands {
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
    const { thread: spec, turnId, input: rawInput, model, effort, permissionMode } = kind.value;

    if (!spec || !rawInput) throw new CommandError("INVALID_COMMAND", "thread spec or input missing", true);
    this.ctx.ops.checkCwd(spec.cwd);
    this.ctx.state.cwds.set(spec.threadId, spec.cwd);
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
    // UNSPECIFIED (an older gateway): the thread's mode.
    const settings = { model, effort, permissionMode: permissionMode || spec.permissionMode };

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

    // E.g. the turn died with the previous process: the gateway ends it on its side.
    if (!this.ctx.state.running.has(`${threadId}/${turnId}`))
      throw new CommandError(TURN_NOT_RUNNING, "the turn is not running on this worker", true);
    // Remembered with the turn: if it ends without the worker seeing it, its interruption was asked for.
    await this.ctx.state.options.runtime.runPromise(Journal.use((j) => j.noteInterrupt(threadId, turnId)));

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
