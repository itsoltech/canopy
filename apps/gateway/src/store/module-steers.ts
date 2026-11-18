import type { SqlClient } from "effect/sql";

export const UNCONFIRMED_MODULE_STEER = "The Threads module was turned off before the worker confirmed delivery.";

/** Only undispatched input may fall back automatically. A delayed journal event settles an ambiguous send. */
export function suspendThreadSteers(sql: SqlClient.SqlClient, owner: string) {
  return sql`UPDATE turn_steers s SET status = CASE WHEN s.status = 'accepted' OR EXISTS (
      SELECT 1 FROM worker_commands c WHERE c.id = s.id AND c.kind = 'steerTurn'
        AND (c.status = 'completed' OR c.result @> '{"wasDispatched":true}'::jsonb)
    ) THEN 'failed' ELSE 'dropped' END, reason = ${UNCONFIRMED_MODULE_STEER}, updated_at = now()
    FROM threads t WHERE s.thread_id = t.id AND t.owner_user_id = ${owner}::uuid AND s.status IN ('pending', 'accepted')`;
}
