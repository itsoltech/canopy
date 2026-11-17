import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { privateMessengerNotice } from "./store-notify.ts";
import type { BotTurn } from "../bots/types.ts";
import type { MessengerAccounts } from "./store-accounts.ts";
import type { AccountLease, ConversationContext, OutboundMessage, OutboundResult } from "./types.ts";

export function conversationContext(sql: SqlClient.SqlClient, turn: BotTurn) {
  if (!turn.conversation_id) return Effect.succeed(undefined);

  return sql<ConversationContext>`SELECT c.id AS "conversationId",r.account_id AS "accountId",c.channel_id AS "channelId",
    c.thread_id AS "threadId",r.instructions,r.delivery FROM bot_channel_conversations c
    JOIN bot_channel_routes r ON r.id=c.route_id WHERE c.id=${turn.conversation_id}::uuid AND r.bot_id=${turn.bot_id}::uuid`.pipe(
    Effect.map((rows) => rows[0]),
  );
}

/** Called inside finish's fenced transaction: the network write happens only after commit. */
export function finishChannelTurn(sql: SqlClient.SqlClient, turn: BotTurn, status: string, text: string) {
  return Effect.gen(function* () {
    const context = yield* conversationContext(sql, turn);

    if (!context || status !== "completed" || !text.trim()) return;

    const allowed = yield* sql`SELECT r.id FROM bot_channel_routes r JOIN messenger_accounts a ON a.id=r.account_id
      JOIN bot_channel_conversations c ON c.route_id=r.id WHERE c.id=${turn.conversation_id}::uuid
      AND r.deleted_at IS NULL AND a.enabled AND a.deleted_at IS NULL
      AND (c.channel_id=ANY(r.channel_ids) OR (r.direct_messages AND c.channel_id LIKE 'D%'))`;

    if (!allowed.length) return;

    if (context.delivery === "reply")
      yield* sql`INSERT INTO messenger_outbound(id,account_id,conversation_id,turn_id,channel_id,thread_id,text)
        VALUES(${Bun.randomUUIDv7()}::uuid,${context.accountId}::uuid,${context.conversationId}::uuid,${turn.id}::uuid,
          ${context.channelId},${context.threadId},${text}) ON CONFLICT(turn_id) DO NOTHING`;
    else yield* privateMessengerNotice(sql, turn.bot_id, `messenger-notify:${turn.id}`, text);
  });
}

function deliveryNotice(sql: SqlClient.SqlClient, id: string, refused: boolean) {
  return Effect.gen(function* () {
    const row = (yield* sql<{ bot_id: string; name: string; channel_id: string }>`SELECT r.bot_id,a.name,o.channel_id
      FROM messenger_outbound o JOIN messenger_accounts a ON a.id=o.account_id
      JOIN bot_channel_conversations c ON c.id=o.conversation_id JOIN bot_channel_routes r ON r.id=c.route_id
      JOIN bots b ON b.id=r.bot_id WHERE o.id=${id}::uuid AND b.deleted_at IS NULL`)[0];

    if (!row) return;

    const text = refused
      ? `The reply was not sent in ${row.name} (${row.channel_id}). Check channel permissions and message limits before trying again.`
      : `Delivery of a reply in ${row.name} (${row.channel_id}) could not be confirmed. Check Slack before resending.`;

    yield* privateMessengerNotice(sql, row.bot_id, `messenger-delivery:${id}`, text);
  });
}

/** Match approved subscription mutations: bot rows in ID order, then account, then outbound rows.
 * Notices only update non-key bot fields, so keep ordinary FK checks compatible. */
function lockDeliveryBots(sql: SqlClient.SqlClient, owner: string, accountId: string, ids: readonly string[]) {
  return sql`SELECT b.id FROM bots b WHERE b.owner_user_id=${owner}::uuid AND EXISTS (
    SELECT 1 FROM messenger_outbound o JOIN bot_channel_conversations c ON c.id=o.conversation_id
    JOIN bot_channel_routes r ON r.id=c.route_id
    WHERE r.bot_id=b.id AND o.account_id=${accountId}::uuid AND o.id=ANY(${ids}::uuid[]))
    ORDER BY b.id FOR NO KEY UPDATE OF b`;
}

export function messengerOutbound(sql: SqlClient.SqlClient, accounts: MessengerAccounts) {
  return {
    outbound: (owner: string, lease: AccountLease, now: Date) =>
      sql.withTransaction(
        Effect.gen(function* () {
          // Freeze the recovery set before locking bots: a newly abandoned row belongs to the next poll.
          const candidates = yield* sql<{ id: string }>`SELECT id FROM messenger_outbound
            WHERE account_id=${lease.accountId}::uuid AND status='sending'
              AND lease_token IS DISTINCT FROM ${lease.token}::uuid`;

          if (candidates.length)
            yield* lockDeliveryBots(
              sql,
              owner,
              lease.accountId,
              candidates.map((row) => row.id),
            );
          yield* accounts.fenced(owner, lease, now);

          // A previous process may have sent a message before dying. Preserve an unknown outcome without replaying it.
          const abandoned = yield* sql<{
            id: string;
          }>`UPDATE messenger_outbound SET status='uncertain' WHERE account_id=${lease.accountId}::uuid
        AND id=ANY(${candidates.map((row) => row.id)}::uuid[])
        AND status='sending' AND lease_token IS DISTINCT FROM ${lease.token}::uuid RETURNING id`;

          for (const row of abandoned) yield* deliveryNotice(sql, row.id, false);

          return yield* sql<OutboundMessage>`UPDATE messenger_outbound o SET status='sending',lease_token=${lease.token}::uuid
        WHERE o.id IN (SELECT x.id FROM messenger_outbound x JOIN bot_channel_conversations c ON c.id=x.conversation_id
          JOIN bot_channel_routes r ON r.id=c.route_id JOIN bots b ON b.id=r.bot_id
          WHERE x.account_id=${lease.accountId}::uuid AND x.status='pending' AND x.available_at<=${now}
          AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL
          AND (c.channel_id=ANY(r.channel_ids) OR (r.direct_messages AND c.channel_id LIKE 'D%'))
          ORDER BY x.available_at,x.id FOR UPDATE OF x SKIP LOCKED LIMIT 10)
        RETURNING o.id,o.account_id AS "accountId",o.channel_id AS "channelId",o.thread_id AS "threadId",o.text`;
        }),
      ),
    settleOutbound: (owner: string, lease: AccountLease, id: string, result: OutboundResult, now: Date) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* lockDeliveryBots(sql, owner, lease.accountId, [id]);
          yield* accounts.fenced(owner, lease, now);

          const status = result.refused
            ? "failed"
            : result.sent
              ? "sent"
              : result.uncertain || result.retryAfterMs === undefined
                ? "uncertain"
                : "pending";

          const settled = yield* sql<{
            id: string;
          }>`UPDATE messenger_outbound SET status=${status},available_at=${new Date(now.getTime() + Math.max(1000, result.retryAfterMs ?? 1000))}
        WHERE id=${id}::uuid AND account_id=${lease.accountId}::uuid AND lease_token=${lease.token}::uuid AND status='sending' RETURNING id`;

          if (settled.length && (status === "uncertain" || status === "failed"))
            yield* deliveryNotice(sql, id, status === "failed");
        }),
      ),
  };
}
