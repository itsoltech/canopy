import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { botActivityEvent } from "../bots/activity-event.ts";
import { messengerActivityContext } from "./activity-label.ts";
import { messengerLabel, type MessengerProvider } from "./provider.ts";

/** Only the account label and validated provider identifiers enter the owner's timeline. */
export function channelActivity(sql: SqlClient.SqlClient, turnId: string, key: string, text: string) {
  return Effect.gen(function* () {
    const [source] = yield* sql<{
      bot_id: string;
      account: string;
      channel: string;
      thread: string;
      direct: boolean;
    }>`
      SELECT b.id AS bot_id,a.name AS account,c.channel_id AS channel,c.thread_id AS thread,c.direct
      FROM bot_turns t JOIN bot_channel_conversations c ON c.id=t.conversation_id
      JOIN bot_channel_routes r ON r.id=c.route_id AND r.bot_id=t.bot_id
      JOIN messenger_accounts a ON a.id=r.account_id AND a.owner_user_id=r.owner_user_id
      JOIN bots b ON b.id=t.bot_id AND b.owner_user_id=r.owner_user_id
      WHERE t.id=${turnId}::uuid AND b.deleted_at IS NULL`;

    if (!source) return;
    const context = messengerActivityContext(source.account, source.channel, source.thread, source.direct);
    yield* botActivityEvent(sql, source.bot_id, turnId, key, [text, context].filter(Boolean).join(" · "));
  });
}

/** Provider label of the conversation behind a turn, for owner-facing activity text. */
export function turnProvider(sql: SqlClient.SqlClient, turnId: string) {
  return sql<{ provider: MessengerProvider }>`SELECT a.provider FROM bot_turns t
    JOIN bot_channel_conversations c ON c.id=t.conversation_id JOIN bot_channel_routes r ON r.id=c.route_id
    JOIN messenger_accounts a ON a.id=r.account_id WHERE t.id=${turnId}::uuid`.pipe(
    Effect.map(([row]) => messengerLabel(row?.provider ?? "slack")),
  );
}

export function inboundActivity(sql: SqlClient.SqlClient, turnId: string, inputId: string) {
  return Effect.gen(function* () {
    // Only first fragments represent newly received messages. Continuations can span several turns.
    const [batch] = yield* sql<{ count: number }>`SELECT count(*)::int AS count FROM bot_channel_messages
      WHERE input_id=${inputId}::uuid AND message_id=source_message_id || ':0'`;

    if (!batch?.count) return;
    const provider = yield* turnProvider(sql, turnId);
    const messages = batch.count === 1 ? `a ${provider} message` : `${batch.count} ${provider} messages`;
    yield* channelActivity(sql, turnId, `received:${inputId}`, `Received ${messages}`);
  });
}
