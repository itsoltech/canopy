import { WORKER_OOM_CONTINUATION } from "@canopy/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Provisional end recorded from Hello.running_turns, before replay of the worker journal. */
export const WORKER_RESTARTED = "worker restarted";

/** The caller holds the thread lock, both when recording the OOM and when claiming the queued start. */
function recoverableSource(sql: SqlClient.SqlClient, threadId: string, turnId: string, recoveryId: string) {
  return sql`SELECT u.* FROM turns u JOIN threads t ON t.id = u.thread_id
    WHERE u.thread_id = ${threadId}::uuid AND u.id = ${turnId}::uuid
      AND u.trigger = 'user' AND u.status = 'interrupted' AND u.interrupt_source = 'system'
      AND u.rewind_id IS NULL AND NOT (u.input ? 'shellCommand')
      AND u.provider_session_id = t.provider_thread_id AND t.provider_thread_id <> ''
      AND t.runtime = 'worker' AND t.archived_at IS NULL AND t.deleted_at IS NULL AND t.moved_to IS NULL
      AND t.rewind_pending_id IS NULL AND t.preparation_fingerprint IS NULL
      AND coalesce(t.settings->>'branchNote', '') = ''
      AND u.permission_mode = coalesce(nullif(t.settings->>'permissionMode',''), 'ASK')
      AND (u.goal_id IS NULL OR EXISTS (SELECT 1 FROM goals g WHERE g.id = u.goal_id AND g.status = 'active'))
      AND NOT EXISTS (SELECT 1 FROM worker_commands c WHERE c.turn_id = u.id AND c.kind = 'interruptTurn')
      AND NOT EXISTS (SELECT 1 FROM worker_commands c WHERE c.thread_id = t.id AND c.kind = 'unloadThread'
        AND (c.status IN ('pending','delivered') OR c.created_at >= u.started_at))
      AND NOT EXISTS (SELECT 1 FROM turns q WHERE q.thread_id = t.id AND q.id <> ${recoveryId}::uuid
        AND (q.status IN ('queued','running') OR q.ordinal > u.ordinal))
      AND NOT EXISTS (SELECT 1 FROM turn_steers s WHERE s.thread_id = t.id AND
        (s.status IN ('pending','accepted','dropped') OR (s.turn_id = u.id AND
          s.status = 'delivered' AND num_nonnulls(s.agent_call_id,s.bot_call_id,s.linked_call_id) > 0)))
      AND NOT EXISTS (SELECT 1 FROM agent_bus_calls c WHERE c.target_turn_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM bot_thread_watches w WHERE w.target_thread_id = t.id AND w.target_turn_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM computer_agent_calls c WHERE c.owner_user_id = t.owner_user_id
        AND c.direction = 'incoming' AND c.target_kind = 'thread' AND c.target_id = t.id AND c.target_turn_id = u.id)`;
}

export function queueOomRecovery(sql: SqlClient.SqlClient, threadId: string, turnId: string) {
  const id = Bun.randomUUIDv7();

  return sql`INSERT INTO turns (id, thread_id, ordinal, trigger, resumes_turn_id, resume_reason,
      input, model, effort, service_tier, permission_mode, thread_permission_mode, goal_id)
    SELECT ${id}::uuid, u.thread_id, u.ordinal + 1, 'recovery', u.id, 'worker_oom',
      ${JSON.stringify({ text: WORKER_OOM_CONTINUATION })}::jsonb, u.model, u.effort,
      u.service_tier, u.permission_mode, u.thread_permission_mode, u.goal_id
    FROM (${recoverableSource(sql, threadId, turnId, id)}) u
    ON CONFLICT (resumes_turn_id) WHERE trigger = 'recovery' AND resume_reason = 'worker_oom' DO NOTHING`;
}

/** The original input, session, owner permissions or goal may have been superseded while the gateway was down. */
export function cancelStaleOomRecovery(threadId: string, sourceId: string, recoveryId: string) {
  return SqlClient.SqlClient.use((sql) =>
    sql`UPDATE turns r SET status = 'cancelled', completed_at = now()
      WHERE r.id = ${recoveryId}::uuid AND r.status = 'queued' AND NOT EXISTS (
        SELECT 1 FROM (${recoverableSource(sql, threadId, sourceId, recoveryId)}) u
        WHERE u.permission_mode = r.permission_mode AND u.provider_session_id = r.provider_session_id
          AND u.goal_id IS NOT DISTINCT FROM r.goal_id) RETURNING r.id`.pipe(Effect.map((rows) => rows.length > 0)),
  );
}
