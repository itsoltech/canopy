import { TurnEndSource, TurnOutcome } from "@canopy/contracts";
import { Effect } from "effect";
import { Journal } from "../../journal/index.ts";
import { reconcileTurn, type EndCause } from "../reconcile.ts";

import type { ClaudeThreadContext, Session } from "./thread-types.ts";
import type { sessionOutput } from "./session-output.ts";
import type { sessionTurns } from "./session-turns.ts";

export function sessionCompletion(
  ctx: ClaudeThreadContext,
  session: Session,
  record: ReturnType<typeof sessionOutput>["record"],
  dropSteers: ReturnType<typeof sessionTurns>["dropSteers"],
) {
  const { journal, options } = ctx;
  const { mapper, threadId } = session;

  /** Ends the current turn: free the thread before the gateway hears it is over (it may start the next one). */
  const endTurn = async () => {
    const turn = session.turn;
    session.turn = undefined;

    if (!turn) return;
    turn.ended = true;
    await dropSteers(session, turn);
  };

  const finishTurn = async (cause: EndCause) => {
    const turn = session.turn;

    if (!turn) return;
    await endTurn();
    await record(threadId, {
      turnId: turn.turnId,
      body: {
        case: "turnFinished",
        value: {
          outcome: cause.outcome,
          source: cause.source,
          reason: cause.reason,
          ...(cause.errorCode && { errorCode: cause.errorCode }),
          providerTurnRef: mapper.lastEntry ?? "",
        },
      },
    }).catch(() => {});
  };

  /**
   * The process ended mid-turn on its own: the transcript says how far it got (items it never streamed, its end);
   * without an end there the turn failed in the harness.
   */
  const settleFromTranscript = async (cause: EndCause) => {
    const turn = session.turn;

    if (!turn) return;
    await endTurn();
    await session.io;

    try {
      const open = (await Effect.runPromise(journal.openTurns())).find(
        (t) => t.threadId === threadId && t.turnId === turn.turnId,
      );

      if (!open) return;

      const { events } = await Effect.runPromise(
        reconcileTurn(open, cause).pipe(Effect.provideService(Journal, journal)),
      );

      for (const event of events) options.publish(event);
    } catch {
      await record(threadId, {
        turnId: turn.turnId,
        body: {
          case: "turnFinished",
          value: {
            outcome: cause.outcome,
            source: cause.source,
            reason: cause.reason,
            errorCode: cause.errorCode ?? "",
          },
        },
      }).catch(() => {});
    }
  };

  /** Why the process ended mid-turn: the worker stopping it, the platform interrupting, or the process itself. */
  const knownEnd = (): EndCause | undefined => {
    if (ctx.shuttingDown)
      return { outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.SYSTEM, reason: "worker stopped mid-turn" };

    if (session.turn?.interrupting || session.abort.signal.aborted)
      return { outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.USER, reason: "interrupted" };

    return undefined;
  };

  return { endTurn, finishTurn, settleFromTranscript, knownEnd };
}
