import { TurnEndSource, TurnOrigin, TurnOutcome } from "@canopy/contracts";
import { Schema } from "effect";
import { decodeJson } from "../json.ts";
import type { ThreadEventInit } from "../../journal/index.ts";
import { CLAUDE_VIEW_IMAGE_TOOL } from "./bus.ts";
import { BUS_SERVER, isTaskNotificationAck, startsTurn } from "./mapping.ts";

import type { ClaudeThreadContext, Session } from "./thread-types.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { sessionOutput } from "./session-output.ts";
import type { sessionTurns } from "./session-turns.ts";
import { sessionCompletion } from "./session-completion.ts";
import { userItem, callKey } from "./session-io.ts";

const STEER_GRACE_MS = 60_000;

/** Reads the process's messages until it ends: turns (also the ones Claude starts), steers, background tasks, goals. */
export async function consumeSession(
  ctx: ClaudeThreadContext,
  session: Session,
  output: ReturnType<typeof sessionOutput>,
  turns: ReturnType<typeof sessionTurns>,
) {
  const { options, sessions } = ctx;
  const { record, readOutput, readGoalVerdicts } = output;
  const { beginTurn, closeWhenIdle, dropSteers, suppressWake } = turns;
  const { mapper, threadId } = session;

  const { endTurn, finishTurn, settleFromTranscript, knownEnd } = sessionCompletion(ctx, session, record, dropSteers);
  /** A result that did not end the turn (a steered message was still queued): ends it if nothing follows. */
  let deferredResult: ThreadEventInit | undefined;
  const messages = session.query[Symbol.asyncIterator]();

  try {
    for (;;) {
      // After a deferred result the steered message must start soon; otherwise that result ends the turn.
      const next = deferredResult
        ? await Promise.race([messages.next(), Bun.sleep(STEER_GRACE_MS).then(() => undefined)])
        : await messages.next();

      if (!next && deferredResult) {
        const result = deferredResult;
        deferredResult = undefined;
        await endTurn();
        await record(threadId, result);
        closeWhenIdle(session);
        continue;
      }

      if (!next || next.done) break;
      const message = next.value;

      if (await suppressWake(session, message)) continue;

      // A resumed process first drains old task notifications. Their empty result is not the answer to
      // StartTurn (nor to a queued steer), and must not release or close the waiting input's turn.
      if (isTaskNotificationAck(message)) {
        await record(threadId, { rawJson: JSON.stringify(message) });
        closeWhenIdle(session);
        continue;
      }

      if (deferredResult && session.turn) mapper.continueTurn(session.turn.turnId);
      deferredResult = undefined;

      const annotation = annotateMessage(session, message, record);

      if (annotation) await annotation;

      // Claude starts a turn by itself (e.g. to report a finished background task): a provider turn.
      if (!session.turn && startsTurn(message))
        await beginTurn(session, Bun.randomUUIDv7(), TurnOrigin.PROVIDER, session.model);

      // The task's last output lands before its end.
      if (message.type === "system" && message.subtype === "task_notification")
        await readOutput(session, message.task_id, message.output_file);

      // The evaluator's verdict of this turn belongs to it.
      if (message.type === "result") await readGoalVerdicts(session);

      for (const init of mapper.map(message)) {
        if (init.body?.case === "turnFinished") {
          const turn = session.turn;

          // A steered message still queued in Claude Code runs right after this result: the turn goes on
          // (the result is kept, without its body). An interrupt drops such messages instead.
          if (turn && !turn.interrupting && [...turn.steers.values()].some((s) => !s.started)) {
            deferredResult = init;
            await record(threadId, { turnId: turn.turnId, rawJson: init.rawJson ?? "" });
            continue;
          }

          await endTurn();
        }

        if (init.body?.case === "itemStarted" && init.body.value.item?.content?.case === "backgroundTask")
          session.hadTasks = true;
        await record(threadId, init);
      }

      if (!deferredResult) closeWhenIdle(session);
    }

    if (deferredResult) {
      await endTurn();
      await record(threadId, deferredResult);
    }

    if (session.turn) {
      const known = knownEnd();

      if (known) await finishTurn(known);
      else
        await settleFromTranscript({
          outcome: TurnOutcome.FAILED,
          source: TurnEndSource.HARNESS,
          reason: "harness process exited: the session ended without a result",
          errorCode: "process_exit",
        });
    }
  } catch (error) {
    const known = knownEnd();

    if (known) await finishTurn(known);
    else
      await settleFromTranscript({
        outcome: TurnOutcome.FAILED,
        source: TurnEndSource.HARNESS,
        reason: `harness process exited: ${error instanceof Error ? error.message : String(error)}`,
        errorCode: "process_exit",
      });
  } finally {
    session.input.close();

    if (session.closeTimer) clearTimeout(session.closeTimer);
    await session.io;

    // Tasks die with the process.
    for (const init of mapper.endTasks(ctx.shuttingDown ? (options.closingReason?.() ?? "worker_restart") : "error"))
      await record(threadId, init).catch(() => {});
    await readGoalVerdicts(session);

    if (sessions.get(threadId) === session) sessions.delete(threadId);
  }
}

function annotateMessage(session: Session, message: SDKMessage, record: ReturnType<typeof sessionOutput>["record"]) {
  const lifecycle = Schema.decodeUnknownSync(
    Schema.Struct({
      type: Schema.String,
      command_uuid: Schema.optionalKey(Schema.String),
      state: Schema.optionalKey(Schema.String),
    }),
  )(message);

  const steer =
    lifecycle.type === "command_lifecycle" && lifecycle.state === "started" && lifecycle.command_uuid
      ? session.turn?.steers.get(lifecycle.command_uuid)
      : undefined;

  if (steer && !steer.started && session.turn) {
    steer.started = true;

    return record(
      session.threadId,
      userItem(
        session.turn.turnId,
        `user:${lifecycle.command_uuid}`,
        lifecycle.command_uuid ?? "",
        steer.text,
        steer.authorUserId,
        steer.mentions,
      ),
    );
  }

  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (
        block.type !== "tool_use" ||
        !block.name.startsWith(`mcp__${BUS_SERVER}__`) ||
        block.name === CLAUDE_VIEW_IMAGE_TOOL
      )
        continue;
      const key = callKey(block.name.slice(`mcp__${BUS_SERVER}__`.length), decodeJson(block.input));
      session.busCalls.set(key, [...(session.busCalls.get(key) ?? []), block.id]);
    }
  }

  return undefined;
}
