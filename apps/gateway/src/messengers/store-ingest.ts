import { lockedOwnerModule } from "../store/module-access.ts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid } from "../store/store.ts";
import { recordChannelEvent } from "./channel-context-events.ts";
import { messengerAdapter } from "./adapters.ts";
import type { MessengerProvider } from "./provider.ts";
import { MAX_SLACK_MESSAGE_FILES } from "./slack-events.ts";
import type { MessengerAccounts } from "./store-accounts.ts";
import type {
  AccountLease,
  ConversationRow,
  MessengerEvent,
  MessengerIngestOutcome,
  RouteIngestOutcome,
  RouteRow,
} from "./types.ts";

interface RecordedMessage {
  id: string;
  received_at: Date;
  author_id: string;
  deleted: boolean;
  state: string;
  slack_file_ids: string[];
  source_edited: boolean;
}

/** Without native threads, a reply to a message from an existing conversation continues that conversation. */
function replyThread(sql: SqlClient.SqlClient, route: RouteRow, event: MessengerEvent) {
  return Effect.gen(function* () {
    if (!event.replyTo || event.threadId || event.direct) return event;

    const [conversation] = yield* sql<{ thread_id: string }>`SELECT c.thread_id FROM bot_channel_conversations c
      WHERE c.route_id=${route.id}::uuid AND c.channel_id=${event.channelId} AND (
        EXISTS(SELECT 1 FROM messenger_outbound o WHERE o.account_id=${route.account_id}::uuid
          AND o.channel_id=${event.channelId} AND o.message_id=${event.replyTo} AND o.conversation_id=c.id)
        OR EXISTS(SELECT 1 FROM bot_channel_messages m WHERE m.conversation_id=c.id AND m.message_id=${`${event.replyTo}:0`}))
      ORDER BY c.open_until DESC LIMIT 1`;

    return conversation ? { ...event, threadId: conversation.thread_id } : event;
  });
}

/** Provider file references (column slack_file_ids predates other providers). Adapters validate their shape
 * when mapping events and again before downloading; here only their number and size are bounded. */
function boundedFileIds(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0 && value.length <= 2048))].slice(
    0,
    MAX_SLACK_MESSAGE_FILES,
  );
}

function bufferEvent(
  sql: SqlClient.SqlClient,
  route: RouteRow,
  source: MessengerEvent,
  now: Date,
  capturedAlready = false,
) {
  return Effect.gen(function* () {
    const event = yield* replyThread(sql, route, source);
    const kind = event.kind ?? "message";
    const threadId = route.delivery === "reply" && !event.direct && !event.threadId ? event.messageId : event.threadId;
    const sourceKey = `${event.messageId}:0`;

    const recognized = sql`EXISTS(SELECT 1 FROM bot_channel_messages m
      WHERE m.conversation_id=c.id AND m.message_id=${sourceKey})`;

    let conversation = (yield* sql<ConversationRow>`SELECT c.* FROM bot_channel_conversations c
      WHERE c.route_id=${route.id}::uuid AND c.channel_id=${event.channelId} AND (
        ${recognized} OR (${kind === "message"} AND (
          c.thread_id=${threadId} OR (${!event.threadId && !event.mention && !event.direct && route.delivery === "reply"}
          AND c.root_author_id=${event.authorId} AND (c.open_until>${now} OR EXISTS(
            SELECT 1 FROM bot_turns t WHERE t.conversation_id=c.id AND t.status IN ('queued','running','waiting')))))))
      ORDER BY ${recognized} DESC,(c.thread_id=${threadId}) DESC,c.open_until DESC LIMIT 1 FOR UPDATE`)[0];

    const original = conversation
      ? (yield* sql<RecordedMessage>`SELECT * FROM bot_channel_messages WHERE conversation_id=${conversation.id}::uuid
        AND message_id=${sourceKey}`)[0]
      : undefined;

    const fileIds = boundedFileIds(event.fileIds ?? []);
    let receivedAt = now;

    if (conversation && original) {
      if (
        original.deleted ||
        (kind !== "delete" && !route.user_ids.includes(original.author_id)) ||
        (event.authorId && original.author_id !== event.authorId)
      )
        return "original_message_ignored" as const;

      if (kind === "delete") {
        yield* sql`UPDATE bot_channel_messages SET text=CASE WHEN state='buffered' THEN '' ELSE text END,
          deleted=true,slack_file_ids='{}' WHERE conversation_id=${conversation.id}::uuid
          AND source_message_id=${event.messageId}`;

        return "message_deleted" as const;
      }

      if (kind === "message") {
        // Socket Mode may report the same message as both app_mention and message, with files on only one.
        // An original callback may complete a buffered message, but cannot overwrite an edit or reopen delivery.
        if (fileIds.length && original.state === "buffered" && !original.source_edited)
          yield* sql`UPDATE bot_channel_messages SET slack_file_ids=${boundedFileIds([...original.slack_file_ids, ...fileIds])}::text[]
            WHERE id=${original.id}::bigint`;

        return "duplicate_message" as const;
      }

      const processed = yield* sql`SELECT id FROM bot_channel_messages WHERE conversation_id=${conversation.id}::uuid
        AND source_message_id=${event.messageId} AND state<>'buffered' LIMIT 1`;

      if (processed.length) {
        // Processed text stays immutable. Removed Slack files stop authorizing new imports.
        yield* sql`UPDATE bot_channel_messages SET slack_file_ids=ARRAY(
          SELECT file_id FROM unnest(slack_file_ids) AS file_id WHERE file_id=ANY(${fileIds}::text[])),
          source_edited=true WHERE id=${original.id}::bigint`;

        return "message_updated" as const;
      }

      receivedAt = new Date(original.received_at);
      yield* sql`DELETE FROM bot_channel_messages WHERE conversation_id=${conversation.id}::uuid
        AND source_message_id=${event.messageId}`;
    } else if (kind !== "message") return "original_message_missing" as const;
    // A redelivered passive message cannot become a follow-up by finding a newer open conversation.
    else if (capturedAlready && !event.mention) return "duplicate_message" as const;

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
      return "route_not_triggered" as const;

    if (!conversation) {
      conversation =
        (yield* sql<ConversationRow>`INSERT INTO bot_channel_conversations(id,route_id,channel_id,thread_id,direct,open_until,root_author_id)
        VALUES(${Bun.randomUUIDv7()}::uuid,${route.id}::uuid,${event.channelId},${threadId},${event.direct},${new Date(now.getTime() + 300_000)},${!event.direct && !event.threadId && route.delivery === "reply" ? event.authorId : null})
        RETURNING *`)[0]!;
    }

    // Split by Unicode code points, retaining every fragment durably within the per-batch byte budget.
    const fragments = event.text.match(/[\s\S]{1,4000}/gu) ?? [""];

    for (const [index, fragment] of fragments.entries()) {
      const text = fragments.length > 1 ? `[Message part ${index + 1}/${fragments.length}]\n${fragment}` : fragment;
      yield* sql`INSERT INTO bot_channel_messages(conversation_id,message_id,source_message_id,author_id,text,provider_timestamp,received_at,slack_file_ids,source_edited)
        VALUES(${conversation.id}::uuid,${`${event.messageId}:${index}`},${event.messageId},${event.authorId},${text},${event.timestamp},${receivedAt},${index === 0 ? fileIds : []}::text[],${kind === "edit"})
        ON CONFLICT(conversation_id,message_id) DO NOTHING`;
    }

    yield* sql`UPDATE bot_channel_conversations SET first_received_at=coalesce(first_received_at,${now}),
      last_received_at=${now},open_until=${new Date(now.getTime() + 300_000)} WHERE id=${conversation.id}::uuid`;

    return kind === "edit" ? ("message_updated" as const) : ("buffered" as const);
  });
}

export function messengerIngest(sql: SqlClient.SqlClient, accounts: MessengerAccounts) {
  return (owner: string, source: MessengerEvent, lease: AccountLease, now: Date) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if (
          lease.accountId !== source.accountId ||
          !source.id ||
          source.id.length > 240 ||
          !source.channelId ||
          source.channelId.length > 80 ||
          !source.messageId ||
          source.messageId.length > 100 ||
          source.threadId.length > 100 ||
          (source.replyTo?.length ?? 0) > 100 ||
          (!source.authorId && source.kind !== "delete") ||
          source.authorId.length > 80 ||
          source.timestamp.length > 100 ||
          source.text.length > 100_000
        )
          return yield* Effect.fail(new Invalid("Invalid messenger event"));

        if (!(yield* lockedOwnerModule(sql, owner, "bots")))
          return ["bots_disabled"] satisfies MessengerIngestOutcome[];
        yield* accounts.fenced(owner, lease, now);

        const [account] = yield* sql<{ provider: MessengerProvider }>`SELECT provider FROM messenger_accounts
          WHERE id=${source.accountId}::uuid`;

        const reference = messengerAdapter(account!.provider).fileReference;
        // Only references in the account provider's shape are stored; downloads check them again.
        const fileIds = (source.fileIds ?? []).filter((id) => reference.test(id));
        const event = { ...source, ...(source.fileIds && { fileIds }) };

        const accepted = yield* sql`INSERT INTO messenger_events(account_id,event_id,received_at)
      VALUES(${event.accountId}::uuid,${event.id},${now}) ON CONFLICT DO NOTHING RETURNING event_id`;

        if (!accepted.length) return ["duplicate_event"] satisfies MessengerIngestOutcome[];

        const routes = yield* sql<RouteRow>`SELECT r.* FROM bot_channel_routes r JOIN bots b ON b.id=r.bot_id
      WHERE r.account_id=${event.accountId}::uuid AND r.owner_user_id=${owner}::uuid AND b.owner_user_id=${owner}::uuid
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL
      AND (${event.authorId}=ANY(r.user_ids) OR ${event.kind === "delete" || Boolean(event.ownMutation)})
      AND ((${event.direct} AND r.direct_messages) OR (NOT ${event.direct} AND ${event.channelId}=ANY(r.channel_ids)))`;

        if (!routes.length) return ["no_matching_route"] satisfies MessengerIngestOutcome[];

        const outcomes = new Set<RouteIngestOutcome>();

        for (const route of routes) {
          const channel = yield* recordChannelEvent(sql, route, event);

          const outcome = channel.blocked
            ? "original_message_ignored"
            : yield* bufferEvent(sql, route, channel.event, now, channel.capturedAlready);

          // An edited message from before capture can still be evidence for an admitted turn.
          if (channel.inheritedMutation && (outcome === "message_updated" || outcome === "message_deleted")) {
            yield* sql`UPDATE slack_channel_contexts SET epoch=epoch+1
              WHERE route_id=${route.id}::uuid AND channel_id=${event.channelId}`;
            yield* sql`SELECT invalidate_slack_context_sources(${route.id}::uuid,${event.channelId},
              ARRAY[${event.messageId}]::text[],${event.messageId})`;
          }

          outcomes.add(outcome);
        }

        return [...outcomes];
      }),
    );
}
