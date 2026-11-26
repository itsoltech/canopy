import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { slackTimestamp } from "./slack-events.ts";
import type { MessengerEvent, RouteRow } from "./types.ts";

interface ContextMessage {
  author_id: string;
  text: string;
  deleted: boolean;
  edited_ts: string | null;
  own_reply: boolean;
}

export interface PublishedSlackReply {
  route_id: string;
  turn_id: string;
  channel_id: string;
  thread_id: string;
  text: string;
}

/** The account lock serializes all writes for a channel, including configuration changes. */
export function recordChannelEvent(sql: SqlClient.SqlClient, route: RouteRow, event: MessengerEvent) {
  return Effect.gen(function* () {
    if (event.direct || !route.channel_context || !slackTimestamp.test(event.messageId))
      return { event, blocked: Boolean(event.ownMutation) };

    const kind = event.kind ?? "message";

    const revision = [event.editedTimestamp, event.timestamp, event.messageId].find(
      (ts) => ts && slackTimestamp.test(ts),
    );

    const [prior] =
      yield* sql<ContextMessage>`SELECT author_id,text,deleted,edited_ts,own_reply FROM slack_channel_context_messages
      WHERE route_id=${route.id}::uuid AND channel_id=${event.channelId} AND message_id=${event.messageId}`;

    if (prior?.deleted || (prior && event.authorId && !prior.own_reply && prior.author_id !== event.authorId))
      return { event, blocked: true };

    if (kind === "message" && prior)
      return {
        // A late original must neither replace an edit nor reintroduce removed files.
        event: prior.edited_ts ? { ...event, text: prior.text, fileIds: [] } : event,
        blocked: false,
        capturedAlready: true,
      };

    const deleted = kind === "delete" || (Boolean(event.ownMutation) && !prior);
    const author = prior?.author_id ?? event.authorId;
    const own = prior?.own_reply ?? false;
    const contentChanged = deleted || prior?.text !== event.text;

    if ((own && event.authorId && !event.ownMutation) || (!deleted && !own && !route.user_ids.includes(author)))
      return { event, blocked: true };

    const affected = yield* sql`INSERT INTO slack_channel_context_messages
      (route_id,channel_id,message_id,thread_id,slack_ts,edited_ts,author_id,text,own_reply,deleted,change_no)
      SELECT route_id,channel_id,${event.messageId},${event.threadId},${event.messageId}::numeric,
        ${kind === "edit" ? (revision ?? null) : null}::numeric,${author},${deleted ? "" : event.text},${own},${deleted},head+1
      FROM slack_channel_contexts WHERE route_id=${route.id}::uuid AND channel_id=${event.channelId}
      ON CONFLICT(route_id,channel_id,message_id) DO UPDATE SET text=excluded.text,deleted=excluded.deleted,
        edited_ts=excluded.edited_ts,change_no=CASE WHEN ${contentChanged} THEN excluded.change_no
          ELSE slack_channel_context_messages.change_no END
      WHERE excluded.deleted OR slack_channel_context_messages.edited_ts IS NULL
        OR slack_channel_context_messages.edited_ts<excluded.edited_ts
      RETURNING message_id`;

    if (affected.length && contentChanged) {
      yield* sql`UPDATE slack_channel_contexts SET head=head+1,epoch=epoch+${prior && kind !== "message" ? 1 : 0}
        WHERE route_id=${route.id}::uuid AND channel_id=${event.channelId}`;

      if (prior) {
        yield* sql`SELECT invalidate_slack_context_sources(${route.id}::uuid,${event.channelId},
          ARRAY[${event.messageId}]::text[],${event.messageId})`;
      }
    }

    return {
      event,
      blocked: Boolean(event.ownMutation) || (!affected.length && kind === "edit"),
      inheritedMutation: !prior && kind !== "message",
    };
  });
}

/** Only a reply acknowledged in the configured destination enters the timeline. */
export function recordPublishedReply(sql: SqlClient.SqlClient, reply: PublishedSlackReply, messageId: string) {
  return sql`WITH recorded AS (
    INSERT INTO slack_channel_context_messages
      (route_id,channel_id,message_id,thread_id,slack_ts,author_id,text,own_reply,change_no,reply_sources)
    SELECT s.route_id,s.channel_id,${messageId},${reply.thread_id},${messageId}::numeric,'',${reply.text},true,s.head+1,t.slack_context_sources
    FROM slack_channel_contexts s JOIN bot_turns t ON t.id=${reply.turn_id}::uuid WHERE s.route_id=${reply.route_id}::uuid AND s.channel_id=${reply.channel_id}
      AND t.slack_context_sources IS NOT NULL
    ON CONFLICT DO NOTHING RETURNING route_id,channel_id)
    UPDATE slack_channel_contexts s SET head=head+1 FROM recorded r
    WHERE s.route_id=r.route_id AND s.channel_id=r.channel_id`;
}
