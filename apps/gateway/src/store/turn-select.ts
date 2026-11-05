import type { SqlClient } from "effect/sql";
import { Effect } from "effect";
import type { TurnRow } from "./rows.ts";

/** A live worker command owns the turn before the worker reports it running. */
export const DISPATCHED = `EXISTS (SELECT 1 FROM worker_commands c WHERE c.turn_id = u.id AND c.status IN ('pending', 'delivered', 'completed'))`;

/** Let the worker validate a steer even while its turn_started is still in flight. */
export const steerTarget = (sql: SqlClient.SqlClient, threadId: string) =>
  sql
    .unsafe<TurnRow>(
      `SELECT u.* FROM turns u WHERE u.thread_id = $1::uuid
         AND (u.status = 'running' OR (u.status = 'queued' AND ${DISPATCHED}))
       ORDER BY u.ordinal LIMIT 1`,
      [threadId],
    )
    .pipe(Effect.map((rows) => rows[0]));

/** Nothing else starts while a dispatched turn waits for turn_started. */
export const nextTurn = (sql: SqlClient.SqlClient, threadId: string) =>
  sql
    .unsafe<TurnRow>(
      `
    SELECT u.* FROM turns u JOIN threads t ON t.id = u.thread_id
     WHERE u.thread_id = $1::uuid AND u.status = 'queued' AND t.provider_thread_id IS NOT NULL
       AND t.status IN ('idle', 'interrupted', 'failed') AND t.deleted_at IS NULL AND t.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = u.thread_id AND r.status = 'running')
       AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.status = 'queued' AND ${DISPATCHED})
     ORDER BY u.ordinal LIMIT 1`,
      [threadId],
    )
    .pipe(Effect.map((rows) => rows[0]));
