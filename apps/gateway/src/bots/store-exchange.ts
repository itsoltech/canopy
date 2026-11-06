import { createHash } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { messageView, type MessageRow } from "./store-views.ts";
import { botViewCursor } from "./view-cursor.ts";
import type { BotCore } from "./store-queue.ts";
import { botView } from "./store-views.ts";

/** An exchange can involve several bots; its checkpoint covers their mutable messages, too. */
export function botExchange(sql: SqlClient.SqlClient, core: BotCore) {
  return {
    exchangeView: (owner: string, id: string, cursor?: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;

          const checkpoint =
            cursor !== undefined ? yield* botViewCursor(sql, owner, `exchange:${id}`, cursor) : undefined;

          const selection = checkpoint?.selection;

          const rows = yield* sql<MessageRow>`SELECT m.*,t.status AS turn_status FROM bot_messages m
        JOIN bots b ON b.id=m.bot_id JOIN bot_turns t ON t.id=m.turn_id
        WHERE m.exchange_id=${id}::uuid AND b.owner_user_id=${owner}::uuid AND b.deleted_at IS NULL
          AND (t.reply_to_bot_id IS NOT NULL OR t.remote_recipient_ref IS NOT NULL) AND m.message_key IN ('input','answer')
          AND (${!selection} OR m.id=ANY(${selection?.ids ?? []}::uuid[])
            OR m.turn_id=ANY(${selection?.turns ?? []}::uuid[])) ORDER BY m.seq`;

          const ids = yield* sql<{ bot_id: string }>`SELECT DISTINCT m.bot_id FROM bot_messages m
            JOIN bots b ON b.id=m.bot_id WHERE m.exchange_id=${id}::uuid
            AND b.owner_user_id=${owner}::uuid AND b.deleted_at IS NULL ORDER BY m.bot_id`;

          const participants: bots.Bot[] = [];

          for (const row of ids) participants.push(botView(yield* core.owned(owner, row.bot_id)));

          const digest = createHash("sha256")
            .update(
              toBinary(
                bots.ReadBotExchangeResponseSchema,
                create(bots.ReadBotExchangeResponseSchema, { participants }),
              ),
            )
            .digest("hex");

          const unchanged = !!selection && !!cursor?.endsWith(`:${digest}`);

          return create(bots.ReadBotExchangeResponseSchema, {
            messages: rows.map(messageView),
            cursor: checkpoint ? `${checkpoint.cursor}:${digest}` : "",
            delta: !!selection,
            baseCursor: selection ? (cursor ?? "") : "",
            removedMessageIds: selection?.ids ?? [],
            participants: unchanged ? [] : participants,
            controlsUnchanged: unchanged,
          });
        }),
      ),
  };
}
