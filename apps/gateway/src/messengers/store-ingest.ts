import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid } from "../store/store.ts";
import type { MessengerAccounts } from "./store-accounts.ts";
import type { AccountLease, ConversationRow, MessengerEvent, RouteRow } from "./types.ts";

function bufferEvent(sql: SqlClient.SqlClient, route: RouteRow, event: MessengerEvent, now: Date) {
  return Effect.gen(function* () {
    const threadId = route.delivery === "reply" && !event.direct && !event.threadId ? event.messageId : event.threadId;

    let conversation = (yield* sql<ConversationRow>`SELECT c.* FROM bot_channel_conversations c
      WHERE c.route_id=${route.id}::uuid AND c.channel_id=${event.channelId} AND (
        c.thread_id=${threadId} OR (${!event.threadId && !event.mention && !event.direct && route.delivery === "reply"}
          AND c.root_author_id=${event.authorId} AND (c.open_until>${now} OR EXISTS(
            SELECT 1 FROM bot_turns t WHERE t.conversation_id=c.id AND t.status IN ('queued','running','waiting'))))
        OR (${event.kind === "edit" || event.kind === "delete"} AND EXISTS(SELECT 1 FROM bot_channel_messages m
          WHERE m.conversation_id=c.id AND m.source_message_id=${event.messageId})))
      ORDER BY (c.thread_id=${threadId}) DESC,c.open_until DESC LIMIT 1 FOR UPDATE`)[0];

    const kind = event.kind ?? "message";
    let receivedAt = now;

    if (kind !== "message") {
      if (!conversation) return;

      if (kind === "delete") {
        yield* sql`UPDATE bot_channel_messages SET text='',deleted=true WHERE conversation_id=${conversation.id}::uuid
          AND source_message_id=${event.messageId} AND state='buffered'`;

        return;
      }

      const processed = yield* sql`SELECT id FROM bot_channel_messages WHERE conversation_id=${conversation.id}::uuid
        AND source_message_id=${event.messageId} AND state<>'buffered' LIMIT 1`;

      if (processed.length) return;

      const original = (yield* sql<{
        received_at: Date;
        author_id: string;
        deleted: boolean;
      }>`SELECT received_at,author_id,deleted FROM bot_channel_messages
        WHERE conversation_id=${conversation.id}::uuid AND source_message_id=${event.messageId} ORDER BY id LIMIT 1`)[0];

      if (!original || original.deleted || original.author_id !== event.authorId) return;
      receivedAt = new Date(original.received_at);
      yield* sql`DELETE FROM bot_channel_messages WHERE conversation_id=${conversation.id}::uuid AND source_message_id=${event.messageId}`;
    }

    const running = conversation
      ? yield* sql`SELECT id FROM bot_turns WHERE conversation_id=${conversation.id}::uuid
      AND status IN ('queued','running','waiting') LIMIT 1`
      : [];

    const follows = conversation && (new Date(conversation.open_until).getTime() > now.getTime() || running.length > 0);

    if (
      kind === "message" &&
      !route.observe &&
      !(event.direct && route.direct_messages) &&
      !(event.mention && route.mentions) &&
      !follows
    )
      return;

    if (!conversation) {
      conversation =
        (yield* sql<ConversationRow>`INSERT INTO bot_channel_conversations(id,route_id,channel_id,thread_id,open_until,root_author_id)
        VALUES(${Bun.randomUUIDv7()}::uuid,${route.id}::uuid,${event.channelId},${threadId},${new Date(now.getTime() + 300_000)},${!event.direct && !event.threadId && route.delivery === "reply" ? event.authorId : null})
        RETURNING *`)[0]!;
    }

    const duplicate = yield* sql`SELECT id FROM bot_channel_messages WHERE conversation_id=${conversation.id}::uuid
      AND source_message_id=${event.messageId} LIMIT 1`;

    if (duplicate.length) return;
    // Split by Unicode code points, retaining every fragment durably within the per-batch byte budget.
    const fragments = event.text.match(/[\s\S]{1,4000}/gu) ?? [""];

    for (const [index, fragment] of fragments.entries()) {
      const text = fragments.length > 1 ? `[Message part ${index + 1}/${fragments.length}]\n${fragment}` : fragment;
      yield* sql`INSERT INTO bot_channel_messages(conversation_id,message_id,source_message_id,author_id,text,provider_timestamp,received_at)
        VALUES(${conversation.id}::uuid,${`${event.messageId}:${index}`},${event.messageId},${event.authorId},${text},${event.timestamp},${receivedAt})
        ON CONFLICT(conversation_id,message_id) DO NOTHING`;
    }

    yield* sql`UPDATE bot_channel_conversations SET first_received_at=coalesce(first_received_at,${now}),
      last_received_at=${now},open_until=${new Date(now.getTime() + 300_000)} WHERE id=${conversation.id}::uuid`;
  });
}

export function messengerIngest(sql: SqlClient.SqlClient, accounts: MessengerAccounts) {
  return (owner: string, event: MessengerEvent, lease: AccountLease, now: Date) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if (
          lease.accountId !== event.accountId ||
          !event.id ||
          event.id.length > 240 ||
          !event.channelId ||
          event.channelId.length > 80 ||
          !event.messageId ||
          event.messageId.length > 100 ||
          event.threadId.length > 100 ||
          !event.authorId ||
          event.authorId.length > 80 ||
          event.timestamp.length > 100 ||
          event.text.length > 100_000
        )
          return yield* Effect.fail(new Invalid("Invalid messenger event"));
        yield* accounts.fenced(owner, lease, now);

        const accepted = yield* sql`INSERT INTO messenger_events(account_id,event_id,received_at)
      VALUES(${event.accountId}::uuid,${event.id},${now}) ON CONFLICT DO NOTHING RETURNING event_id`;

        if (!accepted.length) return false;

        const routes = yield* sql<RouteRow>`SELECT r.* FROM bot_channel_routes r JOIN bots b ON b.id=r.bot_id
      WHERE r.account_id=${event.accountId}::uuid AND r.owner_user_id=${owner}::uuid AND b.owner_user_id=${owner}::uuid
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL
      AND (${event.authorId}=ANY(r.user_ids))
      AND ((${event.direct} AND r.direct_messages) OR (NOT ${event.direct} AND ${event.channelId}=ANY(r.channel_ids)))`;

        for (const route of routes) yield* bufferEvent(sql, route, event, now);

        return true;
      }),
    );
}
