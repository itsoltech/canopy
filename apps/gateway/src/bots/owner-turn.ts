import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid } from "../store/errors.ts";
import type { BotTurn } from "./types.ts";

/** The t turn and its m input message must both belong to this private owner conversation. */
export function ownerBotInput(sql: SqlClient.SqlClient) {
  return sql`t.conversation_id IS NULL AND t.slack_context_epoch IS NULL AND t.routine_id IS NULL
    AND t.handoff_configuration IS NULL AND NOT t.reaction_input
    AND t.reply_to_bot_id IS NULL AND t.exchange_id IS NULL AND t.remote_recipient_ref IS NULL AND t.hops=0
    AND m.bot_id=t.bot_id AND m.recipient_id=t.bot_id::text AND m.message_key='input'
    AND m.sender_id='user' AND m.kind='message' AND m.exchange_id IS NULL`;
}

/** Private administration needs a real owner input and the live turn's lease. */
export function requireOwnerBotTurn(sql: SqlClient.SqlClient, owner: string, turn: BotTurn, message: string) {
  return sql`SELECT t.id FROM bot_turns t JOIN bots b ON b.id=t.bot_id
      JOIN bot_messages m ON m.turn_id=t.id
      WHERE t.id=${turn.id}::uuid AND t.bot_id=${turn.bot_id}::uuid AND b.owner_user_id=${owner}::uuid
        AND t.status='running' AND t.lease_token=${turn.lease_token}::uuid AND t.lease_until>now()
        AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL
        AND ${ownerBotInput(sql)}`.pipe(
    Effect.flatMap((rows) => (rows.length ? Effect.void : Effect.fail(new Invalid(message)))),
  );
}
