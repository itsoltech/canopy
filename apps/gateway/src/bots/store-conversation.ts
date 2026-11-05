import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { bots, connectors } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Invalid } from "../store/store.ts";
import { modelInput, storedMentions } from "./mentions.ts";
import { nextHop } from "./policy.ts";
import type { BotTurn, McpConnection, ModelMessage, StoredCall } from "./types.ts";
import {
  approvalView,
  botConfiguration,
  botView,
  messageView,
  requiredString,
  uuid,
  type ApprovalRow,
  type MessageRow,
} from "./store-views.ts";
import type { BotCore } from "./store-queue.ts";

/** Conversations: messages, reads, exchanges and bot-to-bot sends. */
export function botConversation(sql: SqlClient.SqlClient, core: BotCore) {
  const { owned, changed, active, enqueue, routines } = core;

  return {
    markRead: (user: string, id: string, throughSeq: bigint) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owned(user, id, true);

          if (throughSeq < 0n || throughSeq > 9223372036854775807n)
            return yield* Effect.fail(new Invalid("invalid read sequence"));
          // A stale tab can only acknowledge messages it observed, never future messages.
          yield* sql`UPDATE bots SET last_read_seq = greatest(last_read_seq, least(${throughSeq}, coalesce((SELECT max(seq) FROM bot_messages WHERE bot_id = ${id}::uuid), 0))), revision = revision + 1 WHERE id = ${id}::uuid`;

          const latest =
            (yield* sql<MessageRow>`SELECT m.*, t.status AS turn_status FROM bot_messages m JOIN bot_turns t ON t.id = m.turn_id WHERE m.bot_id = ${id}::uuid ORDER BY m.seq DESC LIMIT 1`)[0];

          return create(bots.BotSchema, {
            ...botView(yield* owned(user, id)),
            lastMessage: latest ? messageView(latest) : undefined,
          });
        }),
      ),
    messageUser: (turn: BotTurn, call: StoredCall) =>
      Effect.gen(function* () {
        if (!turn.routine_id)
          return yield* Effect.fail(
            new Invalid("message_user is only available during background routines; reply normally in conversation"),
          );
        yield* sql`INSERT INTO bot_messages(id, bot_id, turn_id, message_key, sender_id, recipient_id, kind, text)
        VALUES (${uuid()}::uuid, ${turn.bot_id}::uuid, ${turn.id}::uuid, ${`user:${call.id}`}, ${turn.bot_id}, 'user', 'message', ${requiredString(call.arguments, "text")})
        ON CONFLICT(turn_id, message_key) DO NOTHING`;
        yield* changed(turn.bot_id);

        return { delivered: true };
      }),
    conversation: (user: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          // Taking the bot lock synchronizes snapshot revisions with all conversation writers.
          const bot = yield* owned(user, id, true);

          const messages =
            yield* sql<MessageRow>`SELECT m.*, t.status AS turn_status, c.result -> 'changes' AS setting_changes
        FROM bot_messages m JOIN bot_turns t ON t.id = m.turn_id LEFT JOIN bot_tool_calls c ON m.message_key = 'self:' || c.id::text
        WHERE m.bot_id = ${id}::uuid ORDER BY m.seq`;

          // A question's options are the arguments of its ask_user call (the approval id is the call id).
          const approvals =
            yield* sql<ApprovalRow>`SELECT a.*, t.routine_title, CASE WHEN a.kind = 'question' THEN c.arguments -> 'options' END AS options
        FROM bot_approvals a JOIN bot_turns t ON t.id = a.turn_id LEFT JOIN bot_tool_calls c ON c.id = a.id WHERE a.bot_id = ${id}::uuid ORDER BY a.created_at, a.id`;

          const active =
            yield* sql`SELECT id FROM bot_turns WHERE bot_id = ${id}::uuid AND handoff_configuration IS NULL AND status IN ('queued','running','waiting') AND (routine_id IS NULL OR status = 'waiting') LIMIT 1`;

          const streaming =
            (yield* sql<{
              text: string;
            }>`SELECT h.text FROM bot_harness_turns h JOIN bot_turns t ON t.id = h.turn_id WHERE h.bot_id = ${id}::uuid AND t.status = 'running' AND t.routine_id IS NULL AND t.handoff_configuration IS NULL ORDER BY t.created_at LIMIT 1`)[0]
              ?.text ?? "";

          const reminders = yield* sql<{
            id: string;
            prompt: string;
            run_at: Date;
          }>`SELECT id, prompt, run_at FROM bot_wakeups WHERE bot_id = ${id}::uuid AND NOT delivered AND NOT cancelled ORDER BY run_at`;

          return create(bots.BotConversationSchema, {
            bot: create(bots.BotSchema, {
              ...botView(bot),
              lastMessage: messages.length ? messageView(messages.at(-1)!) : undefined,
            }),
            messages: messages.map(messageView),
            approvals: approvals.map(approvalView),
            statusLine: active.length ? bot.status_line : "",
            working: active.length > 0,
            streamingText: streaming,
            revision: BigInt(bot.revision),
            routines: yield* routines.routines(user, id),
            reminders: reminders.map((r) =>
              create(bots.BotReminderSchema, {
                id: r.id,
                prompt: r.prompt,
                runAt: timestampFromDate(new Date(r.run_at)),
              }),
            ),
          });
        }),
      ),
    exchange: (user: string, id: string) =>
      sql<MessageRow>`SELECT m.* FROM bot_messages m JOIN bots b ON b.id = m.bot_id JOIN bot_turns t ON t.id = m.turn_id
      WHERE m.exchange_id = ${id}::uuid AND b.owner_user_id = ${user}::uuid AND b.deleted_at IS NULL AND (t.reply_to_bot_id IS NOT NULL OR t.remote_recipient_ref IS NOT NULL) AND m.message_key IN ('input','answer') ORDER BY m.seq`.pipe(
        Effect.map((r) => r.map(messageView)),
      ),
    history: (turn: BotTurn) =>
      sql<
        MessageRow & { model_text: string }
      >`SELECT * FROM (SELECT m.*, CASE WHEN m.message_key='input' THEN t.input ELSE m.text END AS model_text, t.created_at AS turn_created, t.id AS turn_order FROM bot_messages m JOIN bot_turns t ON t.id = m.turn_id
      WHERE m.bot_id = ${turn.bot_id}::uuid AND m.sender_id <> 'self' AND (${Boolean(turn.handoff_configuration)} OR (t.created_at, t.id) <= (SELECT created_at, id FROM bot_turns WHERE id = ${turn.id}::uuid))
      ORDER BY t.created_at DESC, t.id DESC, m.seq DESC LIMIT ${turn.routine_id ? 60 : 2147483647}) recent ORDER BY turn_created, turn_order, seq`.pipe(
        Effect.map((rows): ModelMessage[] => [
          ...rows.map((r): ModelMessage => ({
            role: r.sender_id === turn.bot_id ? "assistant" : "user",
            text: modelInput(r.model_text, storedMentions(r.mentions), r.quotes),
          })),
          ...(turn.routine_id || turn.handoff_configuration ? [{ role: "user" as const, text: turn.input }] : []),
        ]),
      ),
    sendToBot: (user: string, turn: BotTurn, call: StoredCall) =>
      Effect.gen(function* () {
        const target = requiredString(call.arguments, "bot_id", 100);

        if (target === turn.bot_id) return yield* Effect.fail(new Invalid("choose another bot"));
        const hops = nextHop(turn.hops);
        nextHop(hops); // reserve the reply's hop, like notify in the agent bus
        const sender = yield* owned(user, turn.bot_id);
        const recipient = yield* active(user, target);
        yield* enqueue(
          user,
          target,
          `Message from ${botConfiguration(sender).name}: ${requiredString(call.arguments, "text")}`,
          `bot:${call.id}`,
          { hops, sender: turn.bot_id, replyTo: turn.bot_id, exchangeId: call.id, event: true },
        );
        yield* sql`INSERT INTO bot_messages(id, bot_id, turn_id, message_key, sender_id, recipient_id, kind, text, exchange_id)
        VALUES (${uuid()}::uuid, ${turn.bot_id}::uuid, ${turn.id}::uuid, ${call.id}, ${turn.bot_id}, ${target}, 'event', ${`Messaged ${botConfiguration(recipient).name}`}, ${call.id}::uuid) ON CONFLICT(turn_id, message_key) DO NOTHING`;
        yield* changed(sender.id);

        return { bot_id: target, exchange_id: call.id, status: "queued" };
      }),
  };
}

/** Connector connections and credentials stay in the gateway. */
export function botMcp(sql: SqlClient.SqlClient, core: BotCore) {
  const { connections, owned, server, resolvedServer, servers } = core;

  return {
    connected: (user: string, botId: string) =>
      Effect.gen(function* () {
        yield* owned(user, botId);
        const links = (yield* connections.list(user, { botId })).filter((r) => r.status === "connected");
        const result: McpConnection[] = [];

        for (const l of links) result.push(yield* resolvedServer(user, l.id));

        return result;
      }),
    saveServer: (user: string, request: bots.SaveBotMcpServerRequest) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const old = request.id ? yield* server(user, request.id) : undefined;

          const account = yield* connections.save(
            user,
            create(connectors.SaveConnectorAccountRequestSchema, {
              id: request.id,
              connectorType: "custom",
              name: request.name,
              url: request.url,
              transport: request.transport,
              authKind: "headers",
              headers: request.headers,
              replaceCredentials: request.clearHeaders,
              expectedRevision: old ? BigInt(old.revision) : 0n,
            }),
          );

          const id = account.id;

          if (!request.enabled) yield* connections.status(yield* server(user, id), "disconnected");

          return (yield* servers(user)).find((s) => s.id === id)!;
        }),
      ),
    deleteServer: (user: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* server(user, id);
          yield* connections.disconnect(user, id);
          yield* sql`DELETE FROM connector_bot_grants WHERE account_id=${id}::uuid`;
          // Keep public configuration consistent with the normalized connection relation.
          yield* sql`UPDATE bots SET configuration = jsonb_set(configuration, '{mcpServerIds}', coalesce((SELECT jsonb_agg(v) FROM jsonb_array_elements_text(coalesce(configuration -> 'mcpServerIds', '[]')) v WHERE v <> ${id}), '[]')), revision = revision + 1 WHERE owner_user_id = ${user}::uuid`;
        }),
      ),
  };
}
