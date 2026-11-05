import type { v2 } from "@canopy/codex-protocol";
import { GoalDirective, type ThreadSpec, type UserInput } from "@canopy/contracts";
import { Effect } from "effect";
import { SteerError, type TurnSettings } from "../turn-input.ts";
import { codexUserInput } from "./input.ts";

import { CodexThreadError, fail, type CodexThreadContext } from "./thread-types.ts";
import type { threadSessions } from "./thread-sessions.ts";
import type { threadTurnSettings } from "./thread-catalog.ts";

export function threadTurns(
  ctx: CodexThreadContext,
  ensureLoaded: ReturnType<typeof threadSessions>["ensureLoaded"],
  turnSettings: ReturnType<typeof threadTurnSettings>,
) {
  const { codex, connectorCatalog, byPlatform } = ctx;

  return {
    startTurn: Effect.fn("CodexThreads.startTurn")(function* (
      spec: ThreadSpec,
      turnId: string,
      input: UserInput,
      settings?: TurnSettings,
    ) {
      connectorCatalog.set(spec.threadId, spec.connectorTools);
      const entry = yield* ensureLoaded(spec);
      const known = entry.platformToCodex.get(turnId);

      if (known) return known; // redelivered StartTurn: the turn already exists
      const chosen = yield* turnSettings(spec, settings);
      entry.pendingTurns.push(turnId);

      if (input.mentions.length > 0) entry.mentions.set(turnId, { text: input.text, mentions: input.mentions });

      const response = yield* codex
        .request("turn/start", {
          threadId: entry.codexId,
          clientUserMessageId: turnId,
          input: codexUserInput(input),
          ...chosen,
        })
        .pipe(
          Effect.mapError(fail(spec.threadId, "turn/start")),
          Effect.tapError(() => Effect.sync(() => entry.pendingTurns.splice(entry.pendingTurns.indexOf(turnId), 1))),
        );

      const codexTurn = response.turn.id;

      if (!entry.codexToPlatform.has(codexTurn)) {
        // The response won the race against turn/started: bind now and drop the pending slot.
        entry.pendingTurns.splice(entry.pendingTurns.indexOf(turnId), 1);
        entry.commandTurns.add(codexTurn);
        entry.codexToPlatform.set(codexTurn, turnId);
        entry.platformToCodex.set(turnId, codexTurn);
      }

      return codexTurn;
    }),

    interrupt: Effect.fn("CodexThreads.interrupt")(function* (threadId: string, turnId: string) {
      const entry = byPlatform.get(threadId);
      const codexTurn = entry?.platformToCodex.get(turnId);

      if (!entry || !codexTurn)
        return yield* new CodexThreadError({ threadId, operation: "interrupt", message: "turn is not running here" });
      entry.interrupting.add(codexTurn);
      yield* codex
        .request("turn/interrupt", { threadId: entry.codexId, turnId: codexTurn })
        .pipe(Effect.mapError(fail(threadId, "interrupt")));
    }),

    steer: Effect.fn("CodexThreads.steer")(function* (
      threadId: string,
      turnId: string,
      inputId: string,
      input: UserInput,
    ) {
      const entry = byPlatform.get(threadId);

      if (entry?.steered.has(inputId)) return; // redelivered SteerTurn
      const codexTurn = entry?.platformToCodex.get(turnId);

      if (!entry || !codexTurn || entry.finishedTurns.has(codexTurn)) {
        return yield* new SteerError({
          code: "STEER_NOT_RUNNING",
          message: "the turn is not running on this worker",
        });
      }

      if (input.mentions.length > 0) entry.mentions.set(inputId, { text: input.text, mentions: input.mentions });
      // expectedTurnId: Codex refuses when another turn (or none) is active by now.
      yield* codex
        .request("turn/steer", {
          threadId: entry.codexId,
          expectedTurnId: codexTurn,
          clientUserMessageId: inputId,
          input: codexUserInput(input),
        })
        .pipe(
          Effect.mapError((error) =>
            entry.finishedTurns.has(codexTurn)
              ? new SteerError({
                  code: "STEER_NOT_RUNNING",
                  message: "the turn ended before the message could join it",
                })
              : new SteerError({ code: "STEER_REJECTED", message: error.message }),
          ),
        );
      entry.steered.add(inputId);
    }),
  };
}

export function threadGoals(ctx: CodexThreadContext, ensureLoaded: ReturnType<typeof threadSessions>["ensureLoaded"]) {
  const { codex, byPlatform } = ctx;

  return {
    setGoal: Effect.fn("CodexThreads.setGoal")(function* (
      spec: ThreadSpec,
      directive: GoalDirective,
      objective: string,
      tokenBudget: bigint,
    ) {
      const entry = yield* ensureLoaded(spec);

      // origin "user": the platform acts for the user who set the goal in the UI.
      const set = (params: Omit<v2.ThreadGoalSetParams, "threadId" | "origin">) =>
        codex.request("thread/goal/set", { threadId: entry.codexId, origin: "user", ...params }).pipe(Effect.asVoid);

      const request = (() => {
        switch (directive) {
          case GoalDirective.RUN:
            // With an objective: a new goal (replaces the current one); without: resume.
            return objective
              ? set({ objective, status: "active", tokenBudget: tokenBudget > 0n ? Number(tokenBudget) : null })
              : set({ status: "active" });
          case GoalDirective.PAUSE:
            return set({ status: "paused" });
          case GoalDirective.COMPLETE:
            return set({ status: "complete" });
          case GoalDirective.CLEAR:
            return codex.request("thread/goal/clear", { threadId: entry.codexId, origin: "user" }).pipe(Effect.asVoid);
          default:
            return Effect.fail({ message: `unknown goal directive ${directive}` });
        }
      })();

      yield* request.pipe(Effect.mapError(fail(spec.threadId, "goal")));
    }),

    stopTask: Effect.fn("CodexThreads.stopTask")(function* (threadId: string, taskId: string) {
      const entry = byPlatform.get(threadId);
      const processId = entry?.mapper.markStopping(taskId);

      if (!entry || !processId)
        return yield* new CodexThreadError({ threadId, operation: "stop", message: "the task is not running here" });
      yield* codex
        .request("thread/backgroundTerminals/terminate", { threadId: entry.codexId, processId })
        .pipe(Effect.mapError(fail(threadId, "stop")));
    }),
  };
}
