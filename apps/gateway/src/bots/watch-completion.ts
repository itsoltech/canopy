import { Effect } from "effect";
import type { SqlClient, Statement } from "effect/sql";
import { canReportBotTurn } from "./report-origin.ts";
import { WORKER_RESTARTED } from "../store/worker-oom-recovery.ts";
import type { RoutineOrigin } from "./routines.ts";

/** Under the bot row lock, check the durable input even if its watch was processed in an earlier batch. */
export const hasThreadReport = (sql: SqlClient.SqlClient, botId: string, turnId: string, origin: RoutineOrigin) =>
  sql`SELECT 1 FROM bot_thread_watches w JOIN bot_turns queued
    ON queued.bot_id=w.bot_id AND queued.client_request_id='thread:' || w.call_id::text AND queued.hops=w.hops
    WHERE w.target_turn_id=${turnId}::uuid AND w.bot_id=${botId}::uuid AND w.delivered
      AND queued.conversation_id IS NOT DISTINCT FROM ${origin.conversationId ?? null}::uuid
      AND queued.routine_id IS NOT DISTINCT FROM ${origin.routineId ?? null}::uuid
    LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0));

/** An unchanged pending watch needs attention only at its next deadline. */
export function watchNeedsCheck(sql: SqlClient.SqlClient) {
  return sql`(w.continuation_checked_seq IS NULL OR th.last_seq<>w.continuation_checked_seq
    OR w.continuation_check_at<=now() OR th.rewind_pending_id IS NOT NULL
    OR th.archived_at IS NOT NULL OR th.deleted_at IS NOT NULL)`;
}

/** An interaction can add text to the model without producing a steer or a client message ID. */
export function noUnscopedInteractionInput(
  sql: SqlClient.SqlClient,
  thread: Statement.Fragment,
  turn: Statement.Fragment,
) {
  return sql`NOT EXISTS(SELECT 1 FROM interaction_requests q
    WHERE q.thread_id=${thread} AND q.turn_id=${turn}
      AND (q.status='answered' OR coalesce(q.response->>'message','')<>''))`;
}

/** Hello can retire a turn just before the same connection replays its real result. */
function workerReplayPending(sql: SqlClient.SqlClient) {
  return sql`EXISTS(SELECT 1 FROM worker_connections l
    LEFT JOIN worker_journal_cursors j ON j.worker_id=l.worker_id AND j.journal_id=l.bot_journal_id AND j.thread_id=t.thread_id
    WHERE l.worker_id=th.worker_id AND l.bot_presence_until>now()
      AND (l.bot_journal_pending->>t.thread_id::text)::numeric>coalesce(j.acked_seq,0))`;
}

/**
 * The existing watch still belongs to its original turn and source. Follow only native results with a
 * persisted task link, and stop at the first gap in the thread's executed turns. A provider turn without
 * an end can delay a report while its origin is unknown, but cannot contribute text.
 */
export function watchCompletion(sql: SqlClient.SqlClient) {
  return sql`
  LEFT JOIN LATERAL (
    WITH RECURSIVE work(id, first_seq, last_seq, status, error) AS (
      SELECT t.id, t.first_seq, t.last_seq, t.status, t.error
      WHERE t.status='completed' AND t.rewind_id IS NULL
        AND th.archived_at IS NULL AND th.deleted_at IS NULL AND th.rewind_pending_id IS NULL
        AND EXISTS(SELECT 1 FROM thread_items i WHERE i.thread_id=t.thread_id AND i.turn_id=t.id
          AND i.type='background_task' AND i.content->'backgroundTask'->>'providerRunId' IS NOT NULL)
        AND ${canReportBotTurn(sql, sql`t.thread_id`, sql`t.id`, true)}
        AND ${noUnscopedInteractionInput(sql, sql`t.thread_id`, sql`t.id`)}
      UNION ALL
      SELECT child.id, child.first_seq, child.last_seq, child.status, child.error
      FROM work parent
      JOIN thread_items i ON i.thread_id=t.thread_id AND i.turn_id=parent.id
        AND i.type='background_task' AND i.content->'backgroundTask'->>'providerRunId' IS NOT NULL
      JOIN turns child ON child.thread_id=i.thread_id AND child.background_task_item_id=i.item_id
      WHERE parent.status='completed' AND child.first_seq>parent.first_seq AND child.rewind_id IS NULL
        AND child.completed_at<=t.completed_at+interval '1 hour'
        AND ${noUnscopedInteractionInput(sql, sql`t.thread_id`, sql`child.id`)}
        AND NOT EXISTS(SELECT 1 FROM turn_steers s WHERE s.turn_id=child.id
          AND s.status IN ('pending','accepted','delivered'))
    ), gap AS (
      SELECT u.first_seq, u.trigger,
        (u.status='running' OR (u.status='interrupted' AND u.interrupt_source='system'
          AND u.interrupt_reason=${WORKER_RESTARTED} AND u.last_seq IS NULL AND ${workerReplayPending(sql)})) AS awaiting_result
      FROM turns u
      WHERE u.thread_id=t.thread_id AND u.first_seq>t.first_seq
        AND NOT EXISTS (SELECT 1 FROM work WHERE work.id=u.id)
      ORDER BY u.first_seq LIMIT 1
    ), safe AS (
      SELECT work.* FROM work WHERE NOT EXISTS(SELECT 1 FROM gap WHERE gap.first_seq<=work.first_seq)
    ), unresolved AS (
      SELECT i.status, i.last_seq, n.harness_wakes, n.status AS note_status
      FROM safe
      JOIN thread_items i ON i.thread_id=t.thread_id AND i.turn_id=safe.id
        AND i.type='background_task' AND i.content->'backgroundTask'->>'providerRunId' IS NOT NULL
      LEFT JOIN background_task_notes n ON n.thread_id=i.thread_id AND n.item_id=i.item_id
      WHERE safe.status='completed'
        AND (i.status='in_progress' OR i.last_seq>safe.last_seq)
        AND NOT EXISTS(SELECT 1 FROM turns result JOIN safe confirmed ON confirmed.id=result.id
          WHERE result.thread_id=i.thread_id AND result.background_task_item_id=i.item_id)
    ), deadline AS (
      SELECT t.completed_at+interval '1 hour' AS expires
    ), pending AS (
      SELECT deadline.expires AS check_at FROM deadline WHERE now()<deadline.expires AND EXISTS (
        SELECT 1 FROM unresolved u LEFT JOIN gap ON true
        WHERE (gap.first_seq IS NULL AND u.status='in_progress')
          OR (u.harness_wakes AND u.note_status<>'cancelled'
            AND (gap.first_seq IS NULL OR (gap.trigger='provider' AND gap.awaiting_result AND gap.first_seq>u.last_seq)))
      )
    )
    SELECT safe.id, safe.status, safe.error, pending.check_at,
      EXISTS(SELECT 1 FROM unresolved) AS incomplete
    FROM safe LEFT JOIN pending ON true ORDER BY safe.first_seq DESC LIMIT 1
  ) continuation ON true`;
}
