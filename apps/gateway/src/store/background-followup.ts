import type { SqlClient } from "effect/sql";

/** Accept a native Claude result only for an earlier, naturally ended task of the same thread. */
export function recordBackgroundFollowup(sql: SqlClient.SqlClient, threadId: string, turnId: string, runId: string) {
  return sql`
    UPDATE turns result SET background_task_item_id = (
      SELECT min(i.item_id) FROM thread_items i
      JOIN background_task_notes n ON n.thread_id=i.thread_id AND n.item_id=i.item_id
      JOIN turns parent ON parent.id=i.turn_id AND parent.thread_id=i.thread_id
      WHERE i.thread_id=result.thread_id AND i.type='background_task'
        AND i.content->'backgroundTask'->>'providerRunId'=${runId}
        AND n.harness_wakes AND n.status<>'cancelled'
        AND parent.rewind_id IS NULL AND parent.last_seq<result.first_seq AND i.last_seq<result.first_seq
        AND NOT EXISTS (
          SELECT 1 FROM thread_items other
          JOIN background_task_notes note ON note.thread_id=other.thread_id AND note.item_id=other.item_id
          WHERE other.thread_id=i.thread_id AND other.turn_id IS DISTINCT FROM i.turn_id
            AND note.harness_wakes AND other.last_seq>parent.last_seq
        )
        AND NOT EXISTS(SELECT 1 FROM turns seen
          WHERE seen.thread_id=i.thread_id AND seen.background_task_item_id=i.item_id)
      HAVING count(*)=1
    )
    WHERE result.thread_id=${threadId}::uuid AND result.id=${turnId}::uuid
      AND result.trigger='provider' AND result.status='running' AND result.rewind_id IS NULL
      AND result.background_task_item_id IS NULL
      AND EXISTS(SELECT 1 FROM threads t WHERE t.id=result.thread_id AND t.provider='claude')
  `;
}
