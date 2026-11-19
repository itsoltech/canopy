import type { SqlClient } from "effect/sql";

/** Keep user-chosen source names on one line in activity labels. */
export const activityLabel = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim();

/** Owner-facing timeline metadata. The reserved sender keeps these rows out of model history and notifications. */
export function botActivityEvent(sql: SqlClient.SqlClient, botId: string, turnId: string, key: string, text: string) {
  return sql`INSERT INTO bot_messages(id, bot_id, turn_id, message_key, sender_id, recipient_id, kind, text)
    VALUES (gen_random_uuid(), ${botId}::uuid, ${turnId}::uuid, ${`activity:${key}`}, 'activity', 'user', 'event', ${activityLabel(text)})
    ON CONFLICT(turn_id, message_key) DO NOTHING`;
}
