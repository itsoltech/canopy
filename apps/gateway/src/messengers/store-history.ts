import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { requireOwnerBotTurn } from "../bots/owner-turn.ts";
import type { BotTurn } from "../bots/types.ts";
import { isUuid } from "../store/agent-bus-queries.ts";
import { Invalid } from "../store/errors.ts";
import { activeConversationSource } from "./conversation-access.ts";

export interface HistorySelection {
  channelId: string;
  threadId: string;
  turnId: string;
}

/** Resolve a selected turn under the same owner, subscription and lease snapshot as its messages. */
export function readMessengerHistory(
  sql: SqlClient.SqlClient,
  owner: string,
  turn: BotTurn,
  selection: HistorySelection,
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      yield* requireOwnerBotTurn(sql, owner, turn, "Messenger history requires a private message from your owner");

      if (selection.turnId && !isUuid(selection.turnId)) return yield* Effect.fail(new Invalid("Invalid turn ID"));

      const rows = yield* sql<{
        turn_id: string;
        account: string;
        channel_id: string;
        thread_id: string;
        created_at: Date;
        status: string;
        delivery_status: string | null;
        error_code: string;
        error_source: string;
      }>`SELECT t.id AS turn_id,source.account,source.channel_id,source.thread_id,t.created_at,t.status,
        o.status AS delivery_status,coalesce(m.error_code,'') AS error_code,coalesce(m.error_source,'') AS error_source
        FROM bot_turns t JOIN LATERAL (SELECT a.name AS account,c.channel_id,c.thread_id
          ${activeConversationSource(sql, turn.bot_id, sql`t.conversation_id`)}) source ON true
        LEFT JOIN bot_messages m ON m.turn_id=t.id AND m.message_key='answer'
        LEFT JOIN messenger_outbound o ON o.turn_id=t.id
        WHERE t.bot_id=${turn.bot_id}::uuid AND t.conversation_id IS NOT NULL
          ${selection.turnId ? sql`AND t.id=${selection.turnId}::uuid` : sql``}
          ${selection.channelId ? sql`AND source.channel_id=${selection.channelId}` : sql``}
          ${selection.threadId ? sql`AND source.thread_id=${selection.threadId}` : sql``}
        ORDER BY t.created_at DESC,t.id DESC LIMIT 10`;

      const turns = rows.map((row) => ({ ...row, created_at: new Date(row.created_at).toISOString() }));
      const selected = turns[0];

      if (!selection.turnId || !selected) return { turns };

      const messages = yield* sql<{ sender_id: string; text: string; truncated: boolean }>`
        SELECT sender_id,left(text,4096) AS text,length(text)>4096 AS truncated FROM bot_messages
        WHERE turn_id=${selected.turn_id}::uuid AND bot_id=${turn.bot_id}::uuid
          AND (message_key IN ('input','answer') OR (sender_id='channel' AND message_key LIKE 'steer:%'))
        ORDER BY seq DESC LIMIT 9`;

      return {
        turns: [{ ...selected, messages: messages.slice(0, 8).reverse(), older_messages_omitted: messages.length > 8 }],
      };
    }),
  );
}
