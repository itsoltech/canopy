import type { SqlClient } from "effect/sql";
import { Effect } from "effect";
import type { TurnRow } from "./rows.ts";

/** A live worker command owns the turn before the worker reports it running. */
export const DISPATCHED = `EXISTS (SELECT 1 FROM worker_commands c WHERE c.turn_id = u.id AND c.status IN ('pending', 'delivered', 'completed'))`;

/** Only changed turns for mirror deltas; ordinary snapshots keep the complete visible turn list. */
export const turnsOf = (sql: SqlClient.SqlClient, threadId: string, ids?: readonly string[]) =>
  sql.unsafe<TurnRow>(
    `SELECT u.*, s.*, ${DISPATCHED} AS dispatched,
      (SELECT bt.bot_id FROM bot_tool_calls bc JOIN bot_turns bt ON bt.id=bc.turn_id WHERE bc.id=u.bot_call_id) AS bot_id
      FROM turns u LEFT JOIN turn_sources s ON s.turn_id=u.id WHERE u.thread_id=$1::uuid
      AND ($2::uuid[] IS NULL OR u.id=ANY($2::uuid[]))
      AND NOT EXISTS (SELECT 1 FROM computer_moved_threads m WHERE m.ordinal_turn_id=u.id) ORDER BY u.ordinal`,
    [threadId, ids ?? null],
  );

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
       AND t.rewind_pending_id IS NULL AND u.rewind_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.thread_id = u.thread_id AND r.status = 'running')
       AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.status = 'queued' AND ${DISPATCHED})
     ORDER BY u.ordinal LIMIT 1`,
      [threadId],
    )
    .pipe(Effect.map((rows) => rows[0]));
