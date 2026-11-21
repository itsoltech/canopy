import type { SqlClient } from "effect/sql";
import { canReportBotTurn } from "./report-origin.ts";

/** An unchanged pending watch needs attention only at its next deadline. */
export function watchNeedsCheck(sql: SqlClient.SqlClient) {
  return sql`(w.continuation_checked_seq IS NULL OR th.last_seq<>w.continuation_checked_seq
    OR w.continuation_check_at<=now() OR th.rewind_pending_id IS NOT NULL
    OR th.archived_at IS NOT NULL OR th.deleted_at IS NOT NULL)`;
}

/**
 * The existing watch still belongs to its original turn and source. Follow only native results with a
 * persisted task link, and stop at the first gap in the thread's executed turns. A provider turn without
 * an end can delay a report briefly while its origin is unknown, but cannot contribute text.
 */
export function watchCompletion(sql: SqlClient.SqlClient) {
  return sql`
  LEFT JOIN LATERAL (
    WITH RECURSIVE work(id, first_seq, status, error) AS (
      SELECT t.id, t.first_seq, t.status, t.error
      WHERE t.status='completed' AND t.rewind_id IS NULL
        AND th.archived_at IS NULL AND th.deleted_at IS NULL AND th.rewind_pending_id IS NULL
        AND EXISTS(SELECT 1 FROM thread_items i WHERE i.thread_id=t.thread_id AND i.turn_id=t.id
          AND i.type='background_task' AND i.content->'backgroundTask'->>'providerRunId' IS NOT NULL)
        AND ${canReportBotTurn(sql, sql`t.thread_id`, sql`t.id`, true)}
      UNION ALL
      SELECT child.id, child.first_seq, child.status, child.error
      FROM work parent
      JOIN thread_items i ON i.thread_id=t.thread_id AND i.turn_id=parent.id
        AND i.type='background_task' AND i.content->'backgroundTask'->>'providerRunId' IS NOT NULL
      JOIN background_task_notes note ON note.thread_id=i.thread_id AND note.item_id=i.item_id
      JOIN turns child ON child.thread_id=i.thread_id AND child.background_task_item_id=i.item_id
      WHERE parent.status='completed' AND child.first_seq>parent.first_seq AND child.rewind_id IS NULL
        AND child.started_at<=note.created_at+interval '15 seconds'
        AND child.completed_at<=t.completed_at+interval '1 hour'
        AND NOT EXISTS(SELECT 1 FROM turn_steers s WHERE s.turn_id=child.id
          AND s.status IN ('pending','accepted','delivered'))
    ), gap AS (
      SELECT u.first_seq, u.trigger, u.status, u.started_at FROM turns u
      WHERE u.thread_id=t.thread_id AND u.first_seq>t.first_seq
        AND NOT EXISTS (SELECT 1 FROM work WHERE work.id=u.id)
      ORDER BY u.first_seq LIMIT 1
    ), safe AS (
      SELECT work.* FROM work WHERE NOT EXISTS(SELECT 1 FROM gap WHERE gap.first_seq<=work.first_seq)
    ), unresolved AS (
      SELECT i.status, i.last_seq, n.created_at, n.harness_wakes, n.status AS note_status
      FROM safe
      JOIN thread_items i ON i.thread_id=t.thread_id AND i.turn_id=safe.id
        AND i.type='background_task' AND i.content->'backgroundTask'->>'providerRunId' IS NOT NULL
      LEFT JOIN background_task_notes n ON n.thread_id=i.thread_id AND n.item_id=i.item_id
      WHERE safe.status='completed'
        AND NOT EXISTS(SELECT 1 FROM turns result JOIN safe confirmed ON confirmed.id=result.id
          WHERE result.thread_id=i.thread_id AND result.background_task_item_id=i.item_id)
    ), deadline AS (
      SELECT t.completed_at+interval '1 hour' AS expires
    ), pending AS (
      SELECT min(CASE WHEN gap.first_seq IS NULL AND u.status='in_progress' THEN deadline.expires
        WHEN u.harness_wakes AND u.note_status<>'cancelled' THEN
          CASE WHEN gap.first_seq IS NULL AND now()<u.created_at+interval '15 seconds'
              THEN least(deadline.expires,u.created_at+interval '15 seconds')
            WHEN gap.trigger='provider' AND gap.status='running' AND gap.first_seq>u.last_seq
              AND gap.started_at<=u.created_at+interval '15 seconds' THEN deadline.expires
          END
        END) AS check_at
      FROM unresolved u CROSS JOIN deadline LEFT JOIN gap ON true WHERE now()<deadline.expires
    )
    SELECT safe.id, safe.status, safe.error, pending.check_at,
      EXISTS(SELECT 1 FROM unresolved) AS incomplete
    FROM safe CROSS JOIN pending ORDER BY safe.first_seq DESC LIMIT 1
  ) continuation ON true`;
}
