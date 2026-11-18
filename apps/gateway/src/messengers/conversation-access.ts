import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { linkedMessengerActive } from "./linked-account.ts";

export function activeConversationSource(sql: SqlClient.SqlClient, botId: string, conversationId: string) {
  return sql`FROM bot_channel_conversations c
    JOIN bot_channel_routes r ON r.id=c.route_id JOIN messenger_accounts a ON a.id=r.account_id
    JOIN bots b ON b.id=r.bot_id AND b.owner_user_id=r.owner_user_id AND b.owner_user_id=a.owner_user_id
    WHERE c.id=${conversationId}::uuid AND b.id=${botId}::uuid AND b.deleted_at IS NULL
      AND b.archived_at IS NULL AND b.moved_to IS NULL AND r.deleted_at IS NULL AND a.enabled AND a.deleted_at IS NULL
      AND ${linkedMessengerActive(sql)}
      AND (c.channel_id=ANY(r.channel_ids) OR (r.direct_messages AND c.channel_id LIKE 'D%'))`;
}

/** Recheck a subscription before a delayed callback or another external action. */
export function activeConversation(sql: SqlClient.SqlClient, botId: string, conversationId: string) {
  return sql`SELECT c.id ${activeConversationSource(sql, botId, conversationId)}`.pipe(
    Effect.map((rows) => rows.length > 0),
  );
}

/** Scope external connector downloads to files from Slack messages admitted to this conversation. */
export function allowedInboundSlackFile(
  sql: SqlClient.SqlClient,
  botId: string,
  conversationId: string,
  connectorAccountId: string,
  fileId: string,
) {
  return sql`SELECT c.id ${activeConversationSource(sql, botId, conversationId)}
    AND a.connector_account_id=${connectorAccountId}::uuid AND EXISTS(
      SELECT 1 FROM bot_channel_messages m WHERE m.conversation_id=c.id AND NOT m.deleted
        AND m.author_id=ANY(r.user_ids) AND ${fileId}=ANY(m.slack_file_ids)
    )`.pipe(Effect.map((rows) => rows.length > 0));
}
