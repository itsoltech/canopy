import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { modelInput, storedMentions } from "./mentions.ts";
import type { MessageRow } from "./store-views.ts";
import type { BotTurn, ModelMessage } from "./types.ts";

type HistoryRow = Pick<MessageRow, "mentions" | "quotes" | "attachments" | "created_at" | "sender_id" | "reactions"> & {
  message_id: string | null;
  owner_message: boolean;
  model_text: string;
};

/** A confirmed reaction steer belongs to the receiving turn. Its queued fallback owns its own input. */
export function botHistory(
  sql: SqlClient.SqlClient,
  turn: BotTurn,
  currentTurnOnly: boolean,
  includeOwnerMessageIds: boolean,
) {
  return sql<HistoryRow>`WITH history_turns AS (
    SELECT id, input, created_at FROM bot_turns t
    WHERE bot_id=${turn.bot_id}::uuid AND conversation_id IS NOT DISTINCT FROM ${turn.conversation_id ?? null}::uuid
      AND slack_context_epoch IS NOT DISTINCT FROM ${turn.slack_context_epoch?.toString() ?? null}::bigint
      AND (NOT ${currentTurnOnly} OR id=${turn.id}::uuid)
      AND (${Boolean(turn.handoff_configuration)} OR (created_at,id) <= (SELECT created_at,id FROM bot_turns WHERE id=${turn.id}::uuid))
  ), entries AS (
    SELECT t.created_at AS turn_created,t.id AS turn_order,m.seq,m.created_at,m.id AS message_id,m.sender_id,
      (m.sender_id='user' AND m.recipient_id=${turn.bot_id} AND m.kind='message' AND m.exchange_id IS NULL) AS owner_message,
      CASE WHEN m.message_key='input' THEN t.input ELSE m.text END AS model_text,m.mentions,m.quotes,m.attachments,m.reactions
    FROM history_turns t JOIN bot_messages m ON m.turn_id=t.id AND m.bot_id=${turn.bot_id}::uuid
    WHERE m.sender_id NOT IN ('self','activity')
    UNION ALL
    SELECT t.created_at,t.id,0,r.created_at,NULL,'user',false,r.input,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::text[]
    FROM bot_turns r JOIN history_turns t ON t.id=coalesce(r.steer_target_id,r.id)
    WHERE ${!turn.conversation_id} AND r.bot_id=${turn.bot_id}::uuid AND r.reaction_input
      AND (r.steer_target_id IS NULL OR r.status='completed')
  ) SELECT * FROM (SELECT * FROM entries ORDER BY turn_created DESC,turn_order DESC,created_at DESC,seq DESC
      LIMIT ${turn.routine_id ? 60 : null}) recent ORDER BY turn_created,turn_order,created_at,seq`.pipe(
    Effect.map((rows): ModelMessage[] => [
      ...rows.map((r): ModelMessage => ({
        role: r.sender_id === turn.bot_id ? "assistant" : "user",
        text: modelInput(r.model_text, storedMentions(r.mentions), r.quotes),
        ...(r.owner_message && r.reactions.length > 0 && { botReactions: r.reactions }),
        ...(r.message_id && { messageId: r.message_id, attachments: r.attachments }),
        ...(includeOwnerMessageIds && r.owner_message && { ownerMessage: true }),
        createdAt: new Date(r.created_at).toISOString(),
      })),
      ...(turn.routine_id || turn.handoff_configuration ? [{ role: "user" as const, text: turn.input }] : []),
    ]),
  );
}
