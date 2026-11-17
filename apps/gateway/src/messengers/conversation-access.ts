import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

/** Recheck a subscription before a delayed callback or another external action. */
export function activeConversation(sql: SqlClient.SqlClient, botId: string, conversationId: string) {
  return sql`SELECT c.id FROM bot_channel_conversations c
    JOIN bot_channel_routes r ON r.id=c.route_id JOIN messenger_accounts a ON a.id=r.account_id
    JOIN bots b ON b.id=r.bot_id AND b.owner_user_id=r.owner_user_id AND b.owner_user_id=a.owner_user_id
    WHERE c.id=${conversationId}::uuid AND b.id=${botId}::uuid AND b.deleted_at IS NULL
      AND b.archived_at IS NULL AND b.moved_to IS NULL AND r.deleted_at IS NULL AND a.enabled AND a.deleted_at IS NULL
      AND (c.channel_id=ANY(r.channel_ids) OR (r.direct_messages AND c.channel_id LIKE 'D%'))`.pipe(
    Effect.map((rows) => rows.length > 0),
  );
}
