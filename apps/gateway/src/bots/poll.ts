import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

/** A conservative preflight. Locks and eligibility are rechecked by the existing durable transactions. */
export function botPoll(sql: SqlClient.SqlClient, owner: string, now: Date) {
  return sql<{ ready: boolean; delay_ms: number }>`WITH owned AS (
    SELECT id FROM bots WHERE owner_user_id=${owner}::uuid AND deleted_at IS NULL AND archived_at IS NULL
  ), deadlines AS (
    SELECT extract(epoch FROM (t.lease_until-now()))*1000 AS ms FROM bot_turns t JOIN owned b ON b.id=t.bot_id
      WHERE t.status IN ('queued','running')
    UNION ALL SELECT extract(epoch FROM (w.run_at-now()))*1000 FROM bot_wakeups w JOIN owned b ON b.id=w.bot_id
      WHERE NOT w.delivered AND NOT w.cancelled
    UNION ALL SELECT extract(epoch FROM (r.next_run_at-${now}::timestamptz))*1000 FROM bot_routines r JOIN owned b ON b.id=r.bot_id
      WHERE r.enabled AND r.deleted_at IS NULL AND r.next_run_at IS NOT NULL
  ) SELECT EXISTS(SELECT 1 FROM deadlines WHERE ms IS NULL OR ms<=0)
    OR EXISTS(SELECT 1 FROM bot_thread_watches w JOIN owned b ON b.id=w.bot_id WHERE NOT w.delivered) AS ready,
    least(5000,greatest(0,coalesce((SELECT min(ms) FROM deadlines),5000)))::double precision AS delay_ms`.pipe(
    Effect.map((rows) => rows[0]!),
  );
}
