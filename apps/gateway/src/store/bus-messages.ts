import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

export interface BusMessage {
  call_id: string;
  thread_id: string;
  turn_id: string | null;
  text: string;
  sent_at: string;
}

/** A wait claims messages before delivery; its persisted deadline also bounds recovery after a restart. */
export const waitingForMessage = (sql: SqlClient.SqlClient, recipient: string, turnId: string, sender: string) =>
  sql`SELECT id FROM agent_bus_calls WHERE source_thread_id = ${recipient}::uuid AND source_turn_id = ${turnId}::uuid
    AND tool = 'wait_threads' AND status = 'requested' AND arguments->'thread_ids' ? ${sender}
    AND created_at + coalesce((arguments->>'timeout_seconds')::int, 120) * interval '1 second' > now() LIMIT 1`.pipe(
    Effect.map((rows) => rows.length > 0),
  );

/** Inputs already admitted to a turn cannot be recalled, including StartTurn in the outbox. */
const unentered = `NOT EXISTS (SELECT 1 FROM turn_steers s WHERE s.agent_call_id = c.id AND s.status = 'delivered')
  AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.id = c.target_turn_id AND
    (u.status <> 'queued' OR EXISTS (SELECT 1 FROM worker_commands w WHERE w.turn_id = u.id
      AND w.kind = 'startTurn' AND w.status IN ('pending', 'delivered', 'completed'))))`;

export const pendingMessages = (sql: SqlClient.SqlClient, recipient: string, senders: readonly string[]) =>
  sql.unsafe<BusMessage>(
    `SELECT c.id AS call_id, c.source_thread_id AS thread_id, c.source_turn_id AS turn_id,
       c.arguments->>'prompt' AS text, to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS sent_at
     FROM agent_bus_calls c JOIN threads t ON t.id = c.source_thread_id
     WHERE c.tool = 'send_message' AND c.status = 'completed' AND c.message_consumed IS NULL
       AND c.target_thread_id = $1::uuid AND c.source_thread_id = ANY($2::uuid[])
       AND t.id <> $1::uuid AND t.root_thread_id = (SELECT root_thread_id FROM threads WHERE id = $1::uuid)
       AND ${unentered} ORDER BY c.created_at, c.id`,
    [recipient, senders],
  );

/** Caller holds the recipient lock, also used by send, notification delivery and queue dispatch. */
export const consumeMessages = (
  sql: SqlClient.SqlClient,
  recipient: string,
  ids: readonly string[],
  reason: "consumed_by_wait" | "consumed_by_read" | "deduplicated",
) =>
  Effect.gen(function* () {
    if (ids.length === 0) return;

    const calls = yield* sql.unsafe<{ id: string; target_turn_id: string | null }>(
      `SELECT c.id, c.target_turn_id FROM agent_bus_calls c
       WHERE c.target_thread_id = $1::uuid AND c.id = ANY($2::uuid[]) AND c.tool = 'send_message'
         AND c.message_consumed IS NULL AND ${unentered} FOR UPDATE OF c`,
      [recipient, ids],
    );

    for (const call of calls) {
      yield* sql`UPDATE agent_bus_calls SET message_consumed = ${reason},
        notify_status = CASE WHEN notify_status = 'pending' THEN 'cancelled' ELSE notify_status END
        WHERE id = ${call.id}::uuid`;
      yield* sql`UPDATE turns SET status = 'cancelled', completed_at = now()
        WHERE id = ${call.target_turn_id}::uuid AND status = 'queued'`;
      yield* sql`UPDATE turn_steers SET status = 'failed', reason = ${reason}, updated_at = now()
        WHERE agent_call_id = ${call.id}::uuid AND status IN ('pending', 'accepted', 'dropped')`;
      yield* sql`UPDATE worker_commands SET status = 'failed', completed_at = now()
        WHERE id IN (SELECT id FROM turn_steers WHERE agent_call_id = ${call.id}::uuid AND status = 'failed')
          AND status IN ('pending', 'delivered')`;
    }
  });

/** Only the final text from the same child turn can duplicate a completion report. */
export const deduplicateMessageReport = (
  sql: SqlClient.SqlClient,
  recipient: string,
  child: string,
  turnId: string,
  text: string,
) =>
  Effect.gen(function* () {
    const matching = yield* sql<{ id: string; observed: boolean }>`SELECT c.id,
      (c.message_consumed IN ('consumed_by_wait', 'consumed_by_read')
        OR EXISTS (SELECT 1 FROM turn_steers s WHERE s.agent_call_id = c.id AND s.status = 'delivered')
        OR EXISTS (SELECT 1 FROM turns u WHERE u.id = c.target_turn_id AND
          (u.started_at IS NOT NULL OR EXISTS (SELECT 1 FROM worker_commands w WHERE w.turn_id = u.id
            AND w.kind = 'startTurn' AND w.status IN ('pending', 'delivered', 'completed'))))) IS TRUE AS observed
      FROM agent_bus_calls c
      WHERE c.tool = 'send_message' AND c.status = 'completed' AND c.source_thread_id = ${child}::uuid
        AND c.source_turn_id = ${turnId}::uuid AND c.target_thread_id = ${recipient}::uuid
        AND c.arguments->>'prompt' = ${text} AND c.message_consumed IS DISTINCT FROM 'deduplicated'`;

    if (matching.length === 0) return false;
    // An observed or entered explicit message wins. Otherwise keep the richer completion report.
    const observed = matching.some((call) => call.observed);

    yield* consumeMessages(
      sql,
      recipient,
      matching.map((call) => call.id),
      "deduplicated",
    );

    return observed;
  });
