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
    exchangeView: (owner: string, request: bots.ReadBotExchangeRequest) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const { exchangeId: id, pageSize, beforeSeq } = request;
          const cursor = request.incremental ? request.cursor : undefined;
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;

          const checkpoint =
            cursor !== undefined ? yield* botViewCursor(sql, owner, `exchange:${id}`, cursor) : undefined;

          const reset = beforeSeq > 0n && !checkpoint?.selection;
          const before = reset ? 0n : beforeSeq;
          const selection = beforeSeq > 0n ? undefined : checkpoint?.selection;
          const limit = !selection && pageSize ? Math.min(pageSize, 100) : 0;

          const messages = yield* sql<MessageRow>`SELECT * FROM (SELECT m.*,t.status AS turn_status FROM bot_messages m
        JOIN bots b ON b.id=m.bot_id JOIN bot_turns t ON t.id=m.turn_id
        WHERE m.exchange_id=${id}::uuid AND b.owner_user_id=${owner}::uuid AND b.deleted_at IS NULL
          AND (t.reply_to_bot_id IS NOT NULL OR t.remote_recipient_ref IS NOT NULL) AND m.message_key IN ('input','answer')
          AND (${!selection} OR m.id=ANY(${selection?.ids ?? []}::uuid[])
            OR m.turn_id=ANY(${selection?.turns ?? []}::uuid[]))
          AND (${before === 0n} OR m.seq<${before}) ORDER BY m.seq DESC LIMIT ${limit ? limit + 1 : null}) recent ORDER BY seq`;

          const hasMore = !!limit && messages.length > limit;
          const rows = hasMore ? messages.slice(1) : messages;

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
            historyBeforeSeq: rows[0] ? BigInt(rows[0].seq) : 0n,
            historyHasMore: hasMore,
            historyReset: reset,
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
