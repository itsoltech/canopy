import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { workerDiagnostics } from "../../diagnostics/worker.ts";
import { type ForkSpec, type ThreadSpec, type UserInput } from "@canopy/contracts";
import { Effect, Schema } from "effect";
import { isClaudeEffort } from "../models.ts";
import { SteerError, TurnAdmissionCancelled, type TurnSettings } from "../turn-input.ts";

import { ClaudeThreadError, fail, type ClaudeThreadContext } from "./thread-types.ts";
import type { claudeRuntime } from "./session-runtime.ts";
import type { claudeSessions } from "./sessions.ts";
import type { sessionOutput } from "./session-output.ts";
import type { sessionTurns } from "./session-turns.ts";
import { userMessage } from "./session-io.ts";
import { submitClaudeTurn } from "./turn-admission.ts";

export function threadCreation(ctx: ClaudeThreadContext, runtime: ReturnType<typeof claudeRuntime>) {
  const { options, journal } = ctx;
  const { runtimeOf, inHome } = runtime;

  return {
    create: Effect.fn("ClaudeThreads.create")(function* (spec: ThreadSpec, fork?: ForkSpec) {
      const forkProfile = fork ? options.profile(spec.providerProfileId) : undefined;
      const forkHome = forkProfile ? runtimeOf(forkProfile).home : options.home;

      const sessionId = fork
        ? yield* Effect.tryPromise({
            try: () =>
              inHome(forkHome, () =>
                forkSession(fork.sourceProviderThreadId, {
                  dir: spec.cwd,
                  ...(fork.afterProviderTurnRef && { upToMessageId: fork.afterProviderTurnRef }),
                }),
              ).then((r) => r.sessionId),
            catch: fail(spec.threadId, "fork"),
          })
        : spec.threadId;

      yield* journal
        .append(spec.threadId, { body: { case: "threadReady", value: { providerThreadId: sessionId } } })
        .pipe(
          Effect.tap((event) => Effect.sync(() => options.publish(event))),
          Effect.mapError(fail(spec.threadId, "journal")),
        );

      return sessionId;
    }),
  };
}

export function threadStart(
  ctx: ClaudeThreadContext,
  sessionsRuntime: ReturnType<typeof claudeSessions>,
  turns: ReturnType<typeof sessionTurns>,
  record: ReturnType<typeof sessionOutput>["record"],
) {
  const { options, sessions, started, resolvedModels, modelEfforts } = ctx;
  const { open, switchMode } = sessionsRuntime;

  return {
    startTurn: Effect.fn("ClaudeThreads.startTurn")(function* (
      spec: ThreadSpec,
      turnId: string,
      input: UserInput,
      settings?: TurnSettings,
    ) {
      if (started.has(turnId)) return; // redelivered StartTurn
      const model = settings?.model || spec.model;
      const mode = settings?.permissionMode || spec.permissionMode;
      const requested = settings?.effort ?? "";

      if (requested && !isClaudeEffort(requested)) {
        return yield* new ClaudeThreadError({
          threadId: spec.threadId,
          operation: "turn",
          message: `unknown reasoning effort "${requested}" (Claude: low, medium, high, xhigh, max)`,
        });
      }

      started.add(turnId);
      workerDiagnostics.turns.begin(spec.threadId, turnId, "claude");
      yield* Effect.tryPromise({
        try: async () => {
          const canSubmit = settings?.canSubmit ?? (() => true);

          if (!canSubmit()) return;
          let session = sessions.get(spec.threadId);

          // A process that is ending (idle, no tasks) finishes first; the turn gets a new one.
          if (session?.closing) {
            await session.done;
            session = undefined;
          }

          if (session?.turn) throw new Error("a turn of this thread is already running");

          if (session && session.mode !== mode && session.mapper.backgroundTasks.length === 0) {
            // Only the grace period after tasks keeps it: a new process starts with the turn's mode.
            if (session.closeTimer) clearTimeout(session.closeTimer);
            session.closeTimer = undefined;
            session.closing = true;
            session.input.close();
            await session.done;
            session = undefined;
          }

          if (!session) {
            // No effort chosen: the device owner's configured default (docs/claude-adapter.md).
            const configured = requested
              ? undefined
              : options.configuredEffort?.([model || "default", resolvedModels.get(model || "default") ?? ""]);

            // Only a level the model offers: a model without efforts gets none (docs/protocol.md, "Wysiłek a model").
            const offered = modelEfforts.get(model || "default");
            const fits = configured && isClaudeEffort(configured) && (!offered || offered.includes(configured));
            const effort = isClaudeEffort(requested) ? requested : fits ? configured : undefined;

            try {
              session = await open(spec, model, effort, mode, settings?.recoveryContext, canSubmit);
            } catch (error) {
              if (error instanceof TurnAdmissionCancelled) return;
              throw error;
            }
          } else {
            // A process kept alive by background tasks: the turn's model and mode apply from now on.
            if (model && model !== session.model) {
              await session.query.setModel(model);
              session.model = model;
            }

            if (mode !== session.mode) await switchMode(session, mode);
          }

          await session.refreshConnectors(spec);
          await settings?.connectorsReady?.();
          await submitClaudeTurn(ctx, session, turnId, input, model, canSubmit, turns, record, settings?.connectorNote);
        },
        catch: fail(spec.threadId, "turn"),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            started.delete(turnId);
            workerDiagnostics.turns.finish(spec.threadId, turnId, true);
          }),
        ),
      );
    }),
  };
}

export function threadControls(ctx: ClaudeThreadContext) {
  const { sessions } = ctx;

  return {
    interrupt: Effect.fn("ClaudeThreads.interrupt")(function* (threadId: string, turnId: string) {
      const session = sessions.get(threadId);

      if (!session?.turn || (turnId && session.turn.turnId !== turnId)) return;
      session.turn.interrupting = true;
      session.mapper.markInterrupted();
      yield* Effect.tryPromise({ try: () => session.query.interrupt(), catch: fail(threadId, "interrupt") }).pipe(
        // A query that does not answer the interrupt is aborted.
        Effect.timeout("10 seconds"),
        Effect.catch(() => Effect.sync(() => session.abort.abort())),
      );
    }),

    steer: Effect.fn("ClaudeThreads.steer")(function* (
      threadId: string,
      turnId: string,
      inputId: string,
      input: UserInput,
    ) {
      const session = sessions.get(threadId);
      const turn = session?.turn;

      if (turn?.turnId === turnId && turn.steers.has(inputId)) return; // redelivered SteerTurn

      if (!session || !turn || turn.turnId !== turnId || turn.ended || turn.interrupting) {
        return yield* new SteerError({
          code: "STEER_NOT_RUNNING",
          message: "the turn is not running on this worker",
        });
      }

      // The uuid names the message in command_lifecycle (queued -> started -> completed).
      if (
        !session.input.push(
          userMessage(input.text, {
            uuid: Schema.decodeUnknownSync(
              Schema.TemplateLiteral([
                Schema.String,
                "-",
                Schema.String,
                "-",
                Schema.String,
                "-",
                Schema.String,
                "-",
                Schema.String,
              ]),
            )(inputId),
            priority: "next",
          }),
        )
      ) {
        return yield* new SteerError({ code: "STEER_NOT_RUNNING", message: "the turn's input is closed" });
      }

      turn.steers.set(inputId, {
        text: input.text,
        authorUserId: input.authorUserId,
        mentions: input.mentions,
        started: false,
      });
    }),

    running: (threadId: string) => sessions.get(threadId)?.turn !== undefined,

    stopTask: Effect.fn("ClaudeThreads.stopTask")(function* (threadId: string, taskId: string) {
      const session = sessions.get(threadId);

      if (!session?.mapper.markStopping(taskId))
        return yield* new ClaudeThreadError({ threadId, operation: "stop", message: "the task is not running here" });
      yield* Effect.tryPromise({ try: () => session.query.stopTask(taskId), catch: fail(threadId, "stop") });
    }),

    backgroundTasks: () =>
      new Map(
        [...sessions.values()].flatMap((s) =>
          s.mapper.backgroundTasks.length > 0 ? [[s.threadId, s.mapper.backgroundTasks] as const] : [],
        ),
      ),
  };
}
