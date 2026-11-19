import { lockedOwnerModule, ownerModule } from "../store/module-access.ts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { activeConversation } from "./conversation-access.ts";
import { linkedMessengerActive } from "./linked-account.ts";
import { inboundActivity } from "./store-activity.ts";
import type { ConversationRow, RouteRow, SteerInput } from "./types.ts";

interface BufferedMessage {
  id: string;
  author_id: string;
  text: string;
  slack_file_ids: string[];
  provider_timestamp: string;
  received_at: Date;
  input_id: string | null;
  unconfirmed: boolean;
}

function resetBufferClock(sql: SqlClient.SqlClient, id: string, now: Date, started: boolean) {
  return sql`UPDATE bot_channel_conversations SET last_dispatched_at=CASE WHEN ${started} THEN ${now} ELSE last_dispatched_at END,
    first_received_at=(SELECT min(received_at) FROM bot_channel_messages WHERE conversation_id=${id}::uuid AND state='buffered' AND NOT deleted),
    last_received_at=(SELECT max(received_at) FROM bot_channel_messages WHERE conversation_id=${id}::uuid AND state='buffered' AND NOT deleted)
    WHERE id=${id}::uuid`;
}

function recoverUnconfirmed(sql: SqlClient.SqlClient, conversationId: string) {
  return Effect.gen(function* () {
    const pending = yield* sql<{ id: string }>`UPDATE bot_channel_inputs i SET status='unconfirmed'
      FROM bot_turns t WHERE i.turn_id=t.id AND i.conversation_id=${conversationId}::uuid
      AND i.status='attempted' AND t.status NOT IN ('queued','running','waiting') RETURNING i.id`;

    for (const row of pending)
      yield* sql`UPDATE bot_channel_messages SET state='buffered' WHERE input_id=${row.id}::uuid AND state='attempted'`;

    if (pending.length)
      yield* sql`UPDATE bot_channel_conversations SET first_received_at=coalesce(first_received_at,now()),
        last_received_at=coalesce(last_received_at,now()) WHERE id=${conversationId}::uuid`;
  });
}

function dispatchConversation(sql: SqlClient.SqlClient, owner: string, id: string, now: Date) {
  return sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* lockedOwnerModule(sql, owner, "bots"))) return undefined;

      // Match bot runtime writers: bot, turn, account, conversation.
      const bots = yield* sql<{ id: string }>`SELECT b.id FROM bots b JOIN bot_channel_routes r ON r.bot_id=b.id
      JOIN bot_channel_conversations c ON c.route_id=r.id JOIN messenger_accounts a ON a.id=r.account_id
      WHERE c.id=${id}::uuid AND b.owner_user_id=${owner}::uuid
      AND r.owner_user_id=b.owner_user_id AND a.owner_user_id=b.owner_user_id
      AND b.deleted_at IS NULL AND b.archived_at IS NULL
      AND b.moved_to IS NULL AND r.deleted_at IS NULL AND a.enabled AND a.deleted_at IS NULL
      AND ${linkedMessengerActive(sql)}
      AND (c.channel_id=ANY(r.channel_ids) OR (r.direct_messages AND c.channel_id LIKE 'D%')) FOR UPDATE OF b SKIP LOCKED`;

      if (!bots[0]) return undefined;
      const botId = bots[0].id;

      const active = (yield* sql<{
        id: string;
        status: string;
        conversation_id: string | null;
      }>`SELECT id,status,conversation_id
      FROM bot_turns WHERE bot_id=${botId}::uuid AND status IN ('queued','running','waiting')
      ORDER BY created_at,id LIMIT 1 FOR UPDATE`)[0];

      // Revocation updates this row. Recheck in a fresh statement after obtaining the lock.
      yield* sql`SELECT a.id FROM messenger_accounts a JOIN bot_channel_routes r ON r.account_id=a.id
        JOIN bot_channel_conversations c ON c.route_id=r.id WHERE c.id=${id}::uuid FOR UPDATE OF a`;

      if (!(yield* activeConversation(sql, botId, id))) return undefined;

      const conversation = (yield* sql<
        ConversationRow & RouteRow
      >`SELECT c.*,r.bot_id,r.account_id,r.observe,r.delivery,r.user_ids
      FROM bot_channel_conversations c JOIN bot_channel_routes r ON r.id=c.route_id WHERE c.id=${id}::uuid FOR UPDATE OF c`)[0]!;

      yield* recoverUnconfirmed(sql, id);

      const messages =
        yield* sql<BufferedMessage>`SELECT m.*,i.status='unconfirmed' AS unconfirmed FROM bot_channel_messages m
      LEFT JOIN bot_channel_inputs i ON i.id=m.input_id WHERE m.conversation_id=${id}::uuid AND m.state='buffered'
      AND NOT m.deleted AND m.author_id=ANY(${conversation.user_ids}::text[]) ORDER BY m.received_at,m.id LIMIT 40`;

      if (!messages.length) {
        yield* sql`UPDATE bot_channel_conversations SET first_received_at=NULL,last_received_at=NULL WHERE id=${id}::uuid`;

        return undefined;
      }

      const elapsed = now.getTime();
      const first = new Date(conversation.first_received_at ?? messages[0]!.received_at).getTime();
      const last = new Date(conversation.last_received_at ?? messages.at(-1)!.received_at).getTime();
      const quiet = conversation.observe ? 10_000 : 3000;
      const maximum = conversation.observe ? 30_000 : 10_000;

      const cooldown =
        conversation.observe && conversation.last_dispatched_at
          ? new Date(conversation.last_dispatched_at).getTime() + 60_000
          : 0;

      if ((!active && elapsed < cooldown) || (elapsed < last + quiet && elapsed < first + maximum)) return undefined;

      // A rejected steer waits for the next turn; never repeatedly send the same transient command.
      if (active && (active.conversation_id !== id || active.status !== "running" || messages.some((m) => m.input_id)))
        return undefined;
      const selected: BufferedMessage[] = [];
      let bytes = 256;

      for (const message of messages) {
        const size =
          Buffer.byteLength(
            JSON.stringify({ author: message.author_id, timestamp: message.provider_timestamp, text: message.text }),
          ) + 1;

        if (selected.length && bytes + size > 32_000) break;
        selected.push(message);
        bytes += size;
      }

      // A Slack file must enter the native attachment pipeline of a fresh durable turn.
      if (active && selected.some((m) => m.slack_file_ids.length)) return undefined;

      const warning = selected.some((m) => m.unconfirmed)
        ? "Delivery of these messages to the previous turn was unconfirmed. Do not repeat completed actions.\n"
        : "";

      const text =
        warning +
        selected
          .map((m) => JSON.stringify({ author: m.author_id, timestamp: m.provider_timestamp, text: m.text }))
          .join("\n");

      const inputId = Bun.randomUUIDv7();
      const turnId = active?.id ?? Bun.randomUUIDv7();

      if (!active) {
        yield* sql`INSERT INTO bot_turns(id,bot_id,client_request_id,input,conversation_id)
        VALUES(${turnId}::uuid,${botId}::uuid,${`messenger:${inputId}`},${text},${id}::uuid)`;
        yield* sql`INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,kind,text)
        VALUES(${Bun.randomUUIDv7()}::uuid,${botId}::uuid,${turnId}::uuid,'input','channel',${botId},'message',${text})`;
      }

      yield* sql`INSERT INTO bot_channel_inputs(id,conversation_id,turn_id,text,status)
      VALUES(${inputId}::uuid,${id}::uuid,${turnId}::uuid,${text},${active ? "attempted" : "applied"})`;
      yield* sql`UPDATE bot_channel_messages SET state=${active ? "attempted" : "consumed"},input_id=${inputId}::uuid
      WHERE id=ANY(${selected.map((m) => m.id)}::bigint[])`;

      if (!active) yield* inboundActivity(sql, turnId, inputId);
      yield* resetBufferClock(sql, id, now, !active);
      yield* sql`UPDATE bots SET revision=revision+1 WHERE id=${botId}::uuid`;

      return active ? ({ id: inputId, botId, turnId, conversationId: id, text } satisfies SteerInput) : undefined;
    }),
  );
}

export function messengerDispatch(sql: SqlClient.SqlClient) {
  return {
    dispatch: (owner: string, now: Date) =>
      Effect.gen(function* () {
        const candidates = yield* sql<{ id: string }>`SELECT c.id FROM bot_channel_conversations c
        JOIN bot_channel_routes r ON r.id=c.route_id JOIN messenger_accounts a ON a.id=r.account_id
        WHERE r.owner_user_id=${owner}::uuid AND a.owner_user_id=r.owner_user_id AND ${ownerModule(sql, owner, "bots")}
        AND r.deleted_at IS NULL AND a.enabled AND a.deleted_at IS NULL AND ${linkedMessengerActive(sql)}
        AND (c.channel_id=ANY(r.channel_ids) OR (r.direct_messages AND c.channel_id LIKE 'D%'))
        AND (c.first_received_at IS NOT NULL OR EXISTS(SELECT 1 FROM bot_channel_inputs i JOIN bot_turns t ON t.id=i.turn_id
          WHERE i.conversation_id=c.id AND i.status='attempted' AND t.status NOT IN ('queued','running','waiting')))
        ORDER BY c.first_received_at NULLS FIRST,c.id LIMIT 100`;

        const steers: SteerInput[] = [];

        for (const candidate of candidates) {
          const steer = yield* dispatchConversation(sql, owner, candidate.id, now);

          if (steer) steers.push(steer);
        }

        return steers;
      }),
    settleSteer: (owner: string, inputId: string, applied: boolean, expectedTurnId?: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ turn_id: string; bot_id: string; text: string }>`UPDATE bot_channel_inputs i
        SET status=${applied ? "applied" : "dropped"} FROM bot_turns t JOIN bots b ON b.id=t.bot_id
        JOIN bot_channel_conversations c ON c.id=t.conversation_id
        JOIN bot_channel_routes r ON r.id=c.route_id JOIN messenger_accounts a ON a.id=r.account_id
        WHERE i.conversation_id=c.id AND r.bot_id=b.id AND r.owner_user_id=b.owner_user_id
        AND a.owner_user_id=b.owner_user_id AND (NOT ${applied} OR (b.deleted_at IS NULL AND b.archived_at IS NULL
          AND b.moved_to IS NULL AND r.deleted_at IS NULL AND a.enabled AND a.deleted_at IS NULL
          AND ${linkedMessengerActive(sql)}
          AND (c.channel_id=ANY(r.channel_ids) OR (r.direct_messages AND c.channel_id LIKE 'D%'))))
        AND i.id=${inputId}::uuid AND i.turn_id=t.id AND b.owner_user_id=${owner}::uuid AND i.status='attempted' AND (${expectedTurnId ?? null}::uuid IS NULL OR i.turn_id=${expectedTurnId ?? null}::uuid)
        RETURNING i.turn_id,t.bot_id,i.text`;

          const row = rows[0];

          if (!row) return;
          yield* sql`UPDATE bot_channel_messages SET state=${applied ? "consumed" : "buffered"} WHERE input_id=${inputId}::uuid`;

          if (applied) {
            yield* sql`INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,kind,text)
          VALUES(${Bun.randomUUIDv7()}::uuid,${row.bot_id}::uuid,${row.turn_id}::uuid,${`steer:${inputId}`},'channel',${row.bot_id},'message',${row.text})
          ON CONFLICT DO NOTHING`;
            yield* inboundActivity(sql, row.turn_id, inputId);
          } else
            yield* sql`UPDATE bot_channel_conversations SET first_received_at=coalesce(first_received_at,now()),
          last_received_at=coalesce(last_received_at,now()) WHERE id=(SELECT conversation_id FROM bot_channel_inputs WHERE id=${inputId}::uuid)`;
        }),
      ),
  };
}
