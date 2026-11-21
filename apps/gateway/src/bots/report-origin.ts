import type { SqlClient, Statement } from "effect/sql";

/** Include the initial input, steers and earlier delivery batches. A turn has one shared transcript. */
export function canReportBotTurn(
  sql: SqlClient.SqlClient,
  thread: Statement.Fragment,
  turn: Statement.Fragment,
  requireSingleOrigin = false,
) {
  return sql`NOT EXISTS (
    SELECT 1 FROM (
      SELECT initial.bot_call_id,initial.linked_call_id FROM turns initial
        WHERE initial.thread_id=${thread} AND initial.id=${turn}
      UNION ALL SELECT steer.bot_call_id,steer.linked_call_id FROM turn_steers steer
        WHERE steer.thread_id=${thread} AND steer.turn_id=${turn} AND steer.status IN ('pending','accepted','delivered')
      UNION ALL SELECT watch.call_id,NULL::uuid FROM bot_thread_watches watch
        WHERE watch.target_thread_id=${thread} AND watch.target_turn_id=${turn}
    ) i LEFT JOIN bot_tool_calls c ON c.id=i.bot_call_id LEFT JOIN bot_turns b ON b.id=c.turn_id
    HAVING (${requireSingleOrigin} OR bool_or(b.conversation_id IS NOT NULL OR i.linked_call_id IS NOT NULL))
      AND count(DISTINCT (b.bot_id,b.conversation_id,b.routine_id,i.linked_call_id))>1
  )`;
}
