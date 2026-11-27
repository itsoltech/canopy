import { Invalid } from "../store/errors.ts";
import { ownerModule } from "../store/module-access.ts";
import { Effect } from "effect";
import type { SqlClient, Statement } from "effect/sql";
import { linkedMessengerActive } from "./linked-account.ts";

export function activeConversationSource(
  sql: SqlClient.SqlClient,
  botId: string | Statement.Fragment,
  conversationId: string | Statement.Fragment,
) {
  return sql`FROM bot_channel_conversations c
    JOIN bot_channel_routes r ON r.id=c.route_id JOIN messenger_accounts a ON a.id=r.account_id
    JOIN bots b ON b.id=r.bot_id AND b.owner_user_id=r.owner_user_id AND b.owner_user_id=a.owner_user_id
    WHERE c.id=${conversationId}::uuid AND b.id=${botId}::uuid AND b.deleted_at IS NULL
      AND b.archived_at IS NULL AND b.moved_to IS NULL AND r.deleted_at IS NULL AND a.enabled AND a.deleted_at IS NULL
      AND ${linkedMessengerActive(sql)} AND ${ownerModule(sql, sql`b.owner_user_id`, "bots")}
      AND (c.channel_id=ANY(r.channel_ids) OR (r.direct_messages AND c.direct))`;
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

/** Use with the turn alias t and conversation alias c. NULL identifies a pre-opt-in conversation. */
export function currentChannelEpoch(sql: SqlClient.SqlClient) {
  return sql`t.slack_context_epoch IS NOT DISTINCT FROM (
    SELECT s.epoch FROM slack_channel_contexts s WHERE s.route_id=c.route_id AND s.channel_id=c.channel_id)`;
}

export function channelTurnSource(sql: SqlClient.SqlClient, turnId: string | Statement.Fragment) {
  return sql`SELECT c.id FROM bot_turns t CROSS JOIN LATERAL (SELECT c.id ${activeConversationSource(sql, sql`t.bot_id`, sql`t.conversation_id`)}
    AND ${currentChannelEpoch(sql)}) c WHERE t.id=${turnId}::uuid`;
}

export function activeChannelTurn(sql: SqlClient.SqlClient, turnId: string) {
  return channelTurnSource(sql, turnId).pipe(Effect.map((rows) => rows.length > 0));
}

/** Serialize the last admission check with source changes before a dispatch or external write. */
export function lockChannelAccount(sql: SqlClient.SqlClient, conversationId: string | Statement.Fragment) {
  return sql`SELECT a.id FROM bot_channel_conversations c JOIN bot_channel_routes r ON r.id=c.route_id
    JOIN messenger_accounts a ON a.id=r.account_id WHERE c.id=${conversationId}::uuid FOR SHARE OF a`;
}

/** Delegated work cannot become a fresh source after the original channel scope has changed. */
export function admitChannelContinuation(
  sql: SqlClient.SqlClient,
  botId: string,
  conversationId: string,
  epoch: string | bigint | null | undefined,
) {
  return Effect.gen(function* () {
    yield* lockChannelAccount(sql, conversationId);

    const source = yield* sql`SELECT 1 ${activeConversationSource(sql, botId, conversationId)}
      AND ${epoch?.toString() ?? null}::bigint IS NOT DISTINCT FROM (
        SELECT s.epoch FROM slack_channel_contexts s WHERE s.route_id=c.route_id AND s.channel_id=c.channel_id)`;

    if (!source.length) return yield* Effect.fail(new Invalid("Messenger subscription is no longer active"));
  });
}
