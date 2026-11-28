import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { ownerModule } from "../store/module-access.ts";
import { pendingThreadQuestions } from "./thread-questions.ts";
import { watchNeedsCheck } from "./watch-completion.ts";

/** A conservative preflight. Locks and eligibility are rechecked by the existing durable transactions. */
export function botPoll(sql: SqlClient.SqlClient, owner: string, now: Date) {
  return sql<{ ready: boolean; configured: boolean }>`WITH owned AS (
    SELECT id FROM bots WHERE owner_user_id=${owner}::uuid AND deleted_at IS NULL AND archived_at IS NULL AND ${ownerModule(sql, owner, "bots")}
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
      WHERE NOT w.delivered AND th.owner_user_id=${owner}::uuid
        AND t.status IN ('completed','failed','interrupted','cancelled') AND ${watchNeedsCheck(sql)})
    OR EXISTS(SELECT 1 ${pendingThreadQuestions(sql)} AND b.id IN (SELECT id FROM owned))
    OR EXISTS(SELECT 1 FROM bot_approvals a JOIN owned b ON b.id=a.bot_id
      WHERE a.parked AND a.status='pending' AND a.expires_at<=now())
    OR EXISTS(SELECT 1 FROM bot_trigger_events e WHERE e.owner_user_id=${owner}::uuid
      AND (e.held_until IS NULL OR e.held_until<=now()))
    OR EXISTS(SELECT 1 FROM bot_trigger_batches x JOIN bot_routines r ON r.id=x.trigger_id JOIN owned b ON b.id=r.bot_id
      WHERE x.status='open' AND (x.check_after IS NULL OR x.check_after<=${now}::timestamptz) AND (x.matched>=20
        OR x.opened_at + make_interval(secs => (r.filter->>'coalesce_seconds')::int) <= ${now}::timestamptz))
    OR EXISTS(SELECT 1 FROM bot_trigger_batches x JOIN bot_routines r ON r.id=x.trigger_id JOIN bots b ON b.id=r.bot_id
      WHERE b.owner_user_id=${owner}::uuid AND x.status<>'open' AND x.closed_at < ${now}::timestamptz - interval '14 days'
        AND NOT EXISTS (SELECT 1 FROM bot_turns t WHERE t.id=x.turn_id AND t.status IN ('queued','running','waiting')))
    OR EXISTS(SELECT 1 FROM bot_thread_watches w JOIN owned b ON b.id=w.bot_id
      JOIN turn_steers s ON s.id=w.target_steer_id
      WHERE NOT w.delivered AND w.target_turn_id IS NULL AND s.status IN ('delivered','queued')) AS ready`.pipe(
    Effect.map((rows) => rows[0]!),
  );
}
