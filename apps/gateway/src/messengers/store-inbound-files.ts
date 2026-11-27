import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { BotTurn } from "../bots/types.ts";
import { activeConversationSource } from "./conversation-access.ts";
import type { MessengerProvider } from "./provider.ts";
import { MAX_SLACK_MESSAGE_FILES } from "./slack-events.ts";

export interface InboundSlackFile {
  account_id: string;
  provider: MessengerProvider;
  file_id: string;
  files_enabled: boolean;
}

/** The input must belong to the currently leased turn and still pass its routing and author checks. */
export function inboundSlackTurnFiles(sql: SqlClient.SqlClient, userId: string, turn: BotTurn, fileId?: string) {
  if (!turn.conversation_id) return Effect.succeed<readonly InboundSlackFile[]>([]);

  return sql<InboundSlackFile>`WITH source AS (
    SELECT c.id, a.id AS account_id, a.provider, r.user_ids, (b.configuration->>'files' IS DISTINCT FROM 'false') AS files_enabled
    ${activeConversationSource(sql, turn.bot_id, turn.conversation_id)} AND b.owner_user_id=${userId}::uuid
  ), admitted AS (
    SELECT DISTINCT ON (ref.file_id) s.account_id, s.provider, ref.file_id, s.files_enabled, m.id, ref.ordinal
    FROM source s JOIN bot_turns t ON t.conversation_id=s.id AND t.bot_id=${turn.bot_id}::uuid
    JOIN bot_channel_inputs i ON i.turn_id=t.id AND i.conversation_id=s.id AND i.status='applied'
    JOIN bot_channel_messages m ON m.input_id=i.id AND m.conversation_id=s.id
    CROSS JOIN LATERAL unnest(m.slack_file_ids) WITH ORDINALITY AS ref(file_id, ordinal)
    WHERE t.id=${turn.id}::uuid AND t.lease_token=${turn.lease_token}::uuid
      AND t.status='running' AND t.lease_until>now() AND m.state='consumed' AND NOT m.deleted
      AND m.author_id=ANY(s.user_ids) AND (${fileId ?? null}::text IS NULL OR (ref.file_id=${fileId ?? null} AND s.files_enabled))
    ORDER BY ref.file_id, m.id, ref.ordinal
  ) SELECT account_id, provider, file_id, files_enabled FROM admitted
    ORDER BY id, ordinal LIMIT ${MAX_SLACK_MESSAGE_FILES + 1}`;
}
