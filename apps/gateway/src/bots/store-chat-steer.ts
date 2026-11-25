import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { BotSteerDelivery } from "./types.ts";

/** Called under the bot lock, which also serializes claiming, stopping and journal ingestion. */
export function chatSteerTarget(sql: SqlClient.SqlClient, botId: string, { waitForHandoff = false } = {}) {
  return sql<Pick<BotSteerDelivery, "turnId" | "workerId">>`
    SELECT t.id AS "turnId", h.worker_id AS "workerId"
    FROM bot_turns t JOIN bot_harness_turns h ON h.turn_id = t.id
    JOIN bot_messages m ON m.turn_id = t.id AND m.message_key = 'input' AND m.sender_id = 'user'
    WHERE t.bot_id = ${botId}::uuid AND t.status = 'running' AND t.lease_until > now()
      AND t.conversation_id IS NULL AND t.routine_id IS NULL AND t.handoff_configuration IS NULL
      AND t.exchange_id IS NULL AND h.outcome IS NULL
      AND (${!waitForHandoff} OR NOT EXISTS (
        SELECT 1 FROM bot_turns pending WHERE pending.bot_id = t.bot_id AND pending.handoff_configuration IS NOT NULL
          AND pending.status IN ('queued', 'running', 'waiting')
      ))
    ORDER BY t.created_at, t.id LIMIT 1`.pipe(Effect.map((rows) => rows[0]));
}

/**
 * An applied notice moves the existing bubble into the receiving turn's model history.
 * Any other terminal result leaves the original message queued.
 */
export function settleChatSteer(
  sql: SqlClient.SqlClient,
  botId: string,
  turnId: string,
  inputId: string,
  applied: boolean,
) {
  return Effect.gen(function* () {
    const rows = yield* sql`UPDATE bot_turns
      SET status = CASE WHEN ${applied} THEN 'completed' ELSE status END,
          finished_at = CASE WHEN ${applied} THEN now() ELSE finished_at END,
          steer_target_id = CASE WHEN ${applied} THEN steer_target_id ELSE NULL END
      WHERE id = ${inputId}::uuid AND bot_id = ${botId}::uuid AND steer_target_id = ${turnId}::uuid
        AND status = 'queued'
      RETURNING id`;

    if (applied && rows.length)
      yield* sql`UPDATE bot_messages SET turn_id = ${turnId}::uuid, message_key = ${`steer:${inputId}`}
        WHERE turn_id = ${inputId}::uuid AND bot_id = ${botId}::uuid AND message_key = 'input'`;
  });
}
