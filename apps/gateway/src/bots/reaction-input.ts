import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { chatSteerTarget } from "./store-chat-steer.ts";

/** Called under the bot lock in the transaction that changed the owner's reaction. */
export function enqueueReactionInput(
  sql: SqlClient.SqlClient,
  botId: string,
  messageId: string,
  emoji: string,
  active: boolean,
  messageText: string,
) {
  return Effect.gen(function* () {
    const target = yield* chatSteerTarget(sql, botId);
    const inputId = Bun.randomUUIDv7();
    const excerpt = JSON.stringify(messageText.slice(0, 240));
    const text = `Canopy reaction notification: the user ${active ? "added" : "removed"} ${emoji} ${active ? "on" : "from"} your message ${messageId} (quoted excerpt: ${excerpt}). This is feedback only. Continue any existing work without acknowledging the reaction.`;

    yield* sql`INSERT INTO bot_turns(id, bot_id, client_request_id, input, reaction_input, steer_target_id, created_at)
      VALUES (${inputId}::uuid, ${botId}::uuid, ${`reaction:${inputId}`}, ${text}, true, ${target?.turnId ?? null}::uuid, clock_timestamp())`;

    return target && { ...target, botId, inputId, text };
  });
}
