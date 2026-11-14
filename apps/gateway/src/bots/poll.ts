import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

/** A conservative preflight. Locks and eligibility are rechecked by the existing durable transactions. */
export function botPoll(sql: SqlClient.SqlClient, owner: string, now: Date) {
  return sql<{ ready: boolean; configured: boolean }>`WITH owned AS (
    SELECT id FROM bots WHERE owner_user_id=${owner}::uuid AND deleted_at IS NULL AND archived_at IS NULL
  ) SELECT EXISTS(SELECT 1 FROM owned) AS configured,
    EXISTS(SELECT 1 FROM owned b CROSS JOIN LATERAL (
      SELECT status,lease_until FROM bot_turns WHERE bot_id=b.id AND status IN ('queued','running','waiting')
      ORDER BY CASE WHEN status='running' AND lease_until>now() THEN 0 WHEN handoff_configuration IS NOT NULL THEN 1 ELSE 2 END,
        created_at,id LIMIT 1
    ) t WHERE t.status IN ('queued','running') AND (t.lease_until IS NULL OR t.lease_until<=now()))
    OR EXISTS(SELECT 1 FROM bot_wakeups w JOIN owned b ON b.id=w.bot_id
      WHERE NOT w.delivered AND NOT w.cancelled AND w.run_at<=now())
    OR EXISTS(SELECT 1 FROM bot_routines r JOIN owned b ON b.id=r.bot_id
      WHERE r.enabled AND r.deleted_at IS NULL AND r.next_run_at<=${now}::timestamptz)
    OR EXISTS(SELECT 1 FROM bot_thread_watches w JOIN owned b ON b.id=w.bot_id
      JOIN turns t ON t.id=w.target_turn_id JOIN threads th ON th.id=t.thread_id
      WHERE NOT w.delivered AND th.owner_user_id=${owner}::uuid AND t.status IN ('completed','failed','interrupted','cancelled'))
    OR EXISTS(SELECT 1 FROM bot_thread_watches w JOIN owned b ON b.id=w.bot_id
      JOIN turn_steers s ON s.id=w.target_steer_id
      WHERE NOT w.delivered AND w.target_turn_id IS NULL AND s.status IN ('delivered','queued')) AS ready`.pipe(
    Effect.map((rows) => rows[0]!),
  );
}
