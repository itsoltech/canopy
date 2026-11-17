import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

/** A deliberate owner-visible effect, independent of the raw external history and safe to move with the bot. */
export function privateMessengerNotice(sql: SqlClient.SqlClient, botId: string, requestId: string, text: string) {
  return Effect.gen(function* () {
    const notification = (yield* sql<{
      id: string;
    }>`INSERT INTO bot_turns(id,bot_id,client_request_id,input,status,finished_at)
      VALUES(${Bun.randomUUIDv7()}::uuid,${botId}::uuid,${requestId},'','completed',now())
      ON CONFLICT(bot_id,client_request_id) DO UPDATE SET client_request_id=excluded.client_request_id RETURNING id`)[0]!;

    const added = yield* sql`INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,kind,text)
      VALUES(${Bun.randomUUIDv7()}::uuid,${botId}::uuid,${notification.id}::uuid,'notify',${botId},'user','message',${text})
      ON CONFLICT(turn_id,message_key) DO NOTHING RETURNING id`;

    if (added.length) yield* sql`UPDATE bots SET revision=revision+1,updated_at=now() WHERE id=${botId}::uuid`;
  });
}
