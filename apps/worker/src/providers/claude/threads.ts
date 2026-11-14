import type { ForkSpec, ThreadSpec, UserInput } from "@canopy/contracts";
import { Context, Effect, Layer } from "effect";
import { Journal } from "../../journal/index.ts";
import type { ModelInit } from "../models.ts";
import { SteerError, type TurnSettings } from "../turn-input.ts";
import type { MentionEntryInit } from "../../mentions/catalog.ts";

import { ClaudeThreadError, type ClaudeThreadsOptions, type ClaudeThreadContext } from "./thread-types.ts";
import { claudeRuntime } from "./session-runtime.ts";
import { sessionOutput } from "./session-output.ts";
import { sessionTurns } from "./session-turns.ts";
import { claudeSessions } from "./sessions.ts";
import { consumeSession } from "./session-consumer.ts";
import { threadCreation, threadStart, threadControls } from "./thread-commands.ts";
import { threadCatalog } from "./thread-catalog.ts";
import { claudeRewind } from "./rewind.ts";
import { ClaudeUsage } from "./usage.ts";
import type { RewindThread, ThreadRewindResultSchema } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";

export { ClaudeThreadError, type ClaudeThreadsOptions, type ClaudeInstanceRuntime } from "./thread-types.ts";

export { claudeExtraArgs, goalVerdictOf } from "./session-io.ts";
/**
 * Platform threads on Claude Code through the Agent SDK (docs/claude-adapter.md).
 *
 * - A thread is a Claude session. Its id is chosen by the platform (the thread id), so thread_ready
 *   is recorded at creation without calling the model; a fork copies the source session up to the
 *   fork point (forkSession) and gets a new session id.
 * - A turn runs in a Claude Code process with open input (streaming input mode): a new session with
 *   sessionId on the first turn, resume afterwards. The process ends with the turn unless background tasks
 *   run (docs/execution.md): then it stays, their output is read from their output files, and when one ends
 *   Claude may start a turn by itself (a provider turn). A StartTurn meanwhile goes into the same process.
 *   Events go to the journal first, then to the gateway (publish), in order.
 * - Steered messages go into the same input stream (priority "next": Claude Code takes them in between tool
 *   calls). A steered message that is still queued at the result runs right after it, so the turn goes on
 *   until it has run.
 * - Goals (docs/goals.md): `/goal …` arrives as a turn's input; the evaluator's verdicts are read from the
 *   session transcript after each turn (Claude Code does not stream them to SDK clients).
 * - Every turn notes the session transcript and the offset it starts at (journal turn_harness). A process that ends
 *   mid-turn without a result (it crashed or was killed) settles the turn from the transcript (providers/reconcile.ts):
 *   the end Claude Code recorded, else failed in the harness ("harness process exited"). A turn the worker stops
 *   (shutdown) is interrupted by the system, one the platform interrupts by the user.
 * - Permission prompts and questions go to the platform (interact); agent bus tools to the gateway (callTool).
 * - Native subagents and schedulers are disallowed (native-tools.ts); the bus replaces them.
 */

export class ClaudeThreads extends Context.Service<
  ClaudeThreads,
  {
    readUsage(): Effect.Effect<void>;
    /** Records thread_ready with the session id (forked session for a fork). Returns the session id. */
    create(spec: ThreadSpec, fork?: ForkSpec): Effect.Effect<string, ClaudeThreadError>;
    rewind(request: RewindThread): Effect.Effect<MessageInitShape<typeof ThreadRewindResultSchema>, ClaudeThreadError>;
    /** Starts a turn and returns once it runs; the turn streams into the journal in the background. */
    startTurn(
      spec: ThreadSpec,
      turnId: string,
      input: UserInput,
      settings?: TurnSettings,
    ): Effect.Effect<void, ClaudeThreadError>;
    interrupt(threadId: string, turnId: string): Effect.Effect<void, ClaudeThreadError>;
    /** Adds input to the running turn (the input stream); idempotent by inputId. */
    steer(threadId: string, turnId: string, inputId: string, input: UserInput): Effect.Effect<void, SteerError>;
    /** Whether a turn of this thread runs in this process. */
    running(threadId: string): boolean;
    /** Stops a background task (Claude stopTask). */
    stopTask(threadId: string, taskId: string): Effect.Effect<void, ClaudeThreadError>;
    /** Background tasks still running, per platform thread. */
    backgroundTasks(): ReadonlyMap<string, readonly string[]>;
    /** Includes terminal events still being persisted before a runtime can drain. */
    hasActiveTurns(): boolean;
    /** Models a profile offers (Query.supportedModels() without a prompt; no model turn). */
    listModels(profileId: string): Effect.Effect<{ models: ModelInit[] }, ClaudeThreadError>;
    /** Commands and skills for the composer in a folder (Query.supportedCommands() without a prompt; claude/catalog.ts). */
    listMentionCatalog(
      profileId: string,
      cwd: string,
    ): Effect.Effect<{ entries: MentionEntryInit[]; notes: string[] }, ClaudeThreadError>;
  }
>()("canopy/worker/ClaudeThreads") {
  static readonly layer = (options: ClaudeThreadsOptions) => Layer.effect(ClaudeThreads, make(options));
}

const make = (options: ClaudeThreadsOptions) =>
  Effect.gen(function* () {
    const journal = yield* Journal;

    const ctx: ClaudeThreadContext = {
      usage: new ClaudeUsage(options.onUsage),
      options,
      journal,
      sessions: new Map(),
      started: new Set(),
      resolvedModels: new Map(),
      modelEfforts: new Map(),
      shuttingDown: false,
    };

    const runtime = claudeRuntime(ctx);
    const output = sessionOutput(ctx);
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        ctx.shuttingDown = true;

        for (const session of ctx.sessions.values()) {
          session.input.close();
          session.abort.abort();
        }

        await Promise.allSettled([...ctx.sessions.values()].map((s) => s.done));
      }),
    );

    const poll = setInterval(() => {
      for (const session of ctx.sessions.values())
        for (const taskId of session.mapper.backgroundTasks) void output.readOutput(session, taskId);
    }, options.outputPollMs ?? 1_000);

    yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(poll)));
    const turns = sessionTurns(ctx, output.record);
    const sessions = claudeSessions(ctx, runtime, (session) => consumeSession(ctx, session, output, turns));

    return ClaudeThreads.of({
      readUsage: () => Effect.promise(() => ctx.usage.read(ctx.sessions.values().next().value?.query)),
      rewind: claudeRewind(ctx, runtime),
      ...threadCreation(ctx, runtime),
      ...threadStart(ctx, sessions, turns, output.record),
      ...threadControls(ctx),
      hasActiveTurns: () => output.recording() || [...ctx.sessions.values()].some((session) => !!session.turn),
      ...threadCatalog(ctx, runtime),
    });
  });
