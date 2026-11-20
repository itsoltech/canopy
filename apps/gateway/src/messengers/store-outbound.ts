import { lockedOwnerModule } from "../store/module-access.ts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { channelActivity } from "./store-activity.ts";
import { privateMessengerNotice } from "./store-notify.ts";
import { activeConversation } from "./conversation-access.ts";
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
    if (status === "failed")
      return yield* channelActivity(sql, turn.id, "failed", "Could not finish the Slack request");

    if (status !== "completed" || !text.trim()) return;
    const context = yield* conversationContext(sql, turn);

    if (!context) return;
    // finish already holds bot -> turn; account comes next, matching revocation and delivery writers.
    yield* sql`SELECT a.id FROM messenger_accounts a WHERE a.id=${context.accountId}::uuid FOR UPDATE`;

    if (!(yield* activeConversation(sql, turn.bot_id, context.conversationId))) return;

    const route = (yield* sql<{ delivery: string }>`SELECT r.delivery FROM bot_channel_conversations c
      JOIN bot_channel_routes r ON r.id=c.route_id WHERE c.id=${context.conversationId}::uuid
      AND r.deleted_at IS NULL FOR SHARE OF r`)[0];

    if (!route) return;

    if (route.delivery === "reply")
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

/** The outbox's saved destination must still belong to this turn's active reply route. */
function replyRoute(sql: SqlClient.SqlClient, owner: string) {
  return sql`SELECT r.id FROM bot_channel_conversations c JOIN bot_channel_routes r ON r.id=c.route_id
    JOIN bot_turns t ON t.id=x.turn_id AND t.conversation_id=c.id AND t.bot_id=r.bot_id
    JOIN bots b ON b.id=r.bot_id
    WHERE c.id=x.conversation_id AND c.channel_id=x.channel_id AND c.thread_id=x.thread_id
      AND r.account_id=x.account_id AND r.owner_user_id=${owner}::uuid AND b.owner_user_id=${owner}::uuid
      AND r.delivery='reply' AND r.deleted_at IS NULL AND b.deleted_at IS NULL
      AND b.archived_at IS NULL AND b.moved_to IS NULL
      AND (c.channel_id=ANY(r.channel_ids) OR (r.direct_messages AND c.channel_id LIKE 'D%'))`;
}

export function messengerOutbound(sql: SqlClient.SqlClient, accounts: MessengerAccounts) {
  return {
    sendClaimed: (owner: string, lease: AccountLease, id: string, now: Date, send: () => Promise<OutboundResult>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* lockedOwnerModule(sql, owner, "bots"))) return undefined;
          yield* lockDeliveryBots(sql, owner, lease.accountId, [id]);
          yield* accounts.fenced(owner, lease, now);

          const claimed = sql`x.id=${id}::uuid AND x.account_id=${lease.accountId}::uuid
            AND x.lease_token=${lease.token}::uuid AND x.status='sending'`;

          const rows = yield* sql`SELECT x.id FROM messenger_outbound x WHERE ${claimed}
            AND EXISTS (${replyRoute(sql, owner)} FOR SHARE OF r) FOR UPDATE OF x`;

          if (!rows.length) {
            yield* sql`UPDATE messenger_outbound x SET status='failed' WHERE ${claimed}`;

            return undefined;
          }

          // Start the request under admission, then release the locks before awaiting Slack.
          return { completion: send() };
        }),
      ),
    outbound: (owner: string, lease: AccountLease, now: Date) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* lockedOwnerModule(sql, owner, "bots"))) return [];

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
        WHERE o.id IN (SELECT x.id FROM messenger_outbound x
          WHERE x.account_id=${lease.accountId}::uuid AND x.status='pending' AND x.available_at<=${now}
          AND EXISTS (${replyRoute(sql, owner)})
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

          const [settled] = yield* sql<{
            turn_id: string;
          }>`UPDATE messenger_outbound SET status=${status},available_at=${new Date(now.getTime() + Math.max(1000, result.retryAfterMs ?? 1000))}
        WHERE id=${id}::uuid AND account_id=${lease.accountId}::uuid AND lease_token=${lease.token}::uuid AND status='sending' RETURNING turn_id`;

          if (!settled) return;

          if (status === "sent") yield* channelActivity(sql, settled.turn_id, "sent", "Replied on Slack");
          else if (status === "uncertain" || status === "failed") yield* deliveryNotice(sql, id, status === "failed");
        }),
      ),
  };
}
