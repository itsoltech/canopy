import { NoticeLevel, TurnOrigin } from "@canopy/contracts";
import { Effect } from "effect";
import { transcriptPath } from "./transcript.ts";

import type { ClaudeThreadContext, Session, SessionTurn } from "./thread-types.ts";
import { fileSize } from "./session-io.ts";
import type { sessionOutput } from "./session-output.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { startsTurn } from "./mapping.ts";

export function sessionTurns(ctx: ClaudeThreadContext, record: ReturnType<typeof sessionOutput>["record"]) {
  const { options, journal } = ctx;
  const idleGraceMs = options.idleGraceMs ?? 3_000;
  const suppressed = new WeakSet<Session>();

  const beginTurn = async (session: Session, turnId: string, origin: TurnOrigin, model: string) => {
    if (session.closeTimer) clearTimeout(session.closeTimer);
    session.closeTimer = undefined;
    session.turn = { turnId, steers: new Map(), ended: false, interrupting: false };
    session.mapper.beginTurn(turnId);
    // Where Claude Code records this turn: everything after the transcript's current end.
    const transcript = transcriptPath(session.home, session.sessionId);
    await Effect.runPromise(
      journal
        .noteHarness(session.threadId, turnId, {
          harness: "claude",
          transcript: session.home,
          sessionId: session.sessionId,
          offset: transcript ? fileSize(transcript) : 0,
          providerTurn: "",
        })
        .pipe(Effect.ignore),
    );
    await record(session.threadId, {
      turnId,
      body: { case: "turnStarted", value: { origin, ...(model && { model }) } },
    });
  };

  /** An idle process ends unless background tasks run; after tasks it waits a little for a turn Claude starts. */
  const closeWhenIdle = (session: Session) => {
    if (session.turn || session.closing || session.mapper.backgroundTasks.length > 0 || session.closeTimer) return;

    const close = () => {
      session.closeTimer = undefined;

      if (session.turn || session.mapper.backgroundTasks.length > 0) return;
      session.closing = true;
      session.input.close();
    };

    if (session.hadTasks) session.closeTimer = setTimeout(close, idleGraceMs);
    else close();
  };

  /** Steered messages that never joined their turn: the gateway queues them as the next turn. */
  const dropSteers = async (session: Session, turn: SessionTurn) => {
    for (const [inputId, steer] of turn.steers) {
      if (steer.started) continue;
      turn.steers.delete(inputId);
      await record(session.threadId, {
        turnId: turn.turnId,
        body: {
          case: "notice",
          value: {
            level: NoticeLevel.WARNING,
            code: "steer_dropped",
            message: "the message did not join the turn before it ended",
            dataJson: JSON.stringify({ input_id: inputId }),
          },
        },
      }).catch(() => {});
    }
  };

  const suppressWake = async (session: Session, message: SDKMessage) => {
    if (session.turn || !startsTurn(message)) return false;

    if (!suppressed.has(session) && options.allowProviderTurn?.(session.threadId) !== false) return false;

    if (!suppressed.has(session)) {
      suppressed.add(session);
      await session.query.interrupt().catch(() => {});
      await record(session.threadId, {
        body: {
          case: "notice",
          value: {
            level: NoticeLevel.INFO,
            code: "continuation_suppressed",
            message: "Automatic follow-up skipped because this thread is archived or deleted.",
          },
        },
      });
    }

    if (message.type === "result") suppressed.delete(session);
    closeWhenIdle(session);

    return true;
  };

  return { beginTurn, closeWhenIdle, dropSteers, suppressWake };
}
