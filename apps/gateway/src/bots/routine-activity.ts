import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { botActivityEvent } from "./activity-event.ts";
import type { BotTurn } from "./types.ts";

type RoutineTurn = Pick<BotTurn, "id" | "bot_id" | "routine_id" | "routine_title" | "client_request_id">;

type Phase = "started" | "completed" | "failed" | "interrupted";

export function routineActivity(sql: SqlClient.SqlClient, turn: RoutineTurn, phase: Phase) {
  if (!turn.routine_id) return Effect.void;

  const title = turn.routine_title ? ` “${turn.routine_title}”` : "";

  const subject = turn.client_request_id.startsWith("routine:") ? `Routine${title}` : `Follow-up for routine${title}`;

  const text = `${subject} ${phase === "interrupted" ? "stopped" : phase}`;

  return botActivityEvent(sql, turn.bot_id, turn.id, `routine-${phase}`, text);
}

/** Administrative stops bypass finish(). Only close runs that actually started. */
export function stoppedRoutineActivity(sql: SqlClient.SqlClient, turnIds: string[]) {
  return Effect.gen(function* () {
    if (!turnIds.length) return;

    const turns = yield* sql<RoutineTurn>`SELECT t.id,t.bot_id,t.routine_id,t.routine_title,t.client_request_id
      FROM bot_turns t JOIN bot_messages m ON m.turn_id=t.id AND m.message_key='activity:routine-started'
      WHERE t.id=ANY(${turnIds}::uuid[]) AND t.routine_id IS NOT NULL`;

    for (const turn of turns) yield* routineActivity(sql, turn, "interrupted");
  });
}
