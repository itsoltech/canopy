import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound } from "../store/store.ts";
import type { MessengerAccounts } from "./store-accounts.ts";
import type { MessengerRoute, RouteRow, SaveMessengerRoute } from "./types.ts";

export const routeView = (row: RouteRow): MessengerRoute => ({
  id: row.id,
  botId: row.bot_id,
  accountId: row.account_id,
  channelIds: row.channel_ids,
  userIds: row.user_ids,
  directMessages: row.direct_messages,
  mentions: row.mentions,
  observe: row.observe,
  delivery: row.delivery,
  instructions: row.instructions,
});

export function messengerRoutes(sql: SqlClient.SqlClient, accounts: MessengerAccounts) {
  return {
    routes: (owner: string, botId?: string) =>
      sql<RouteRow>`SELECT r.* FROM bot_channel_routes r JOIN bots b ON b.id=r.bot_id
      WHERE r.owner_user_id=${owner}::uuid AND b.owner_user_id=${owner}::uuid AND r.deleted_at IS NULL
        AND (${botId ?? null}::uuid IS NULL OR r.bot_id=${botId ?? null}::uuid) ORDER BY r.id`.pipe(
        Effect.map((rows) => rows.map(routeView)),
      ),
    saveRoute: (owner: string, input: SaveMessengerRoute) =>
      sql.withTransaction(
        Effect.gen(function* () {
          // Match dispatch, finish and delivery: bot before account, including FK checks on a new route.
          const bot = yield* sql`SELECT id FROM bots WHERE id=${input.botId}::uuid AND owner_user_id=${owner}::uuid
        AND deleted_at IS NULL AND archived_at IS NULL AND moved_to IS NULL FOR NO KEY UPDATE`;

          if (!bot.length) return yield* Effect.fail(new NotFound("Bot not found"));
          // Account lock serializes responder overlap checks; bots never carry account credentials.
          yield* accounts.owned(owner, input.accountId);
          yield* sql`SELECT id FROM messenger_accounts WHERE id=${input.accountId}::uuid FOR UPDATE`;

          if (input.id) {
            const existing = yield* sql`SELECT id FROM bot_channel_routes WHERE id=${input.id}::uuid
          AND bot_id=${input.botId}::uuid AND account_id=${input.accountId}::uuid AND owner_user_id=${owner}::uuid AND deleted_at IS NULL`;

            if (!existing.length) return yield* Effect.fail(new NotFound("Messenger route not found"));
          }

          if (
            input.instructions.length > 10_000 ||
            input.channelIds.length > 100 ||
            !input.userIds.length ||
            input.userIds.length > 100 ||
            input.channelIds.some((id) => !/^[CG][A-Z0-9]{1,79}$/.test(id)) ||
            input.userIds.some((id) => !/^[UW][A-Z0-9]{1,79}$/.test(id)) ||
            (!input.channelIds.length && !input.directMessages) ||
            (!input.mentions && !input.observe && !input.directMessages) ||
            !["reply", "notify"].includes(input.delivery)
          )
            return yield* Effect.fail(new Invalid("Choose channels or direct messages and valid routing settings"));
          const id = input.id ?? Bun.randomUUIDv7();

          const duplicate = yield* sql`SELECT id FROM bot_channel_routes WHERE bot_id=${input.botId}::uuid
        AND account_id=${input.accountId}::uuid AND deleted_at IS NULL AND id<>${id}::uuid`;

          if (duplicate.length)
            return yield* Effect.fail(new Invalid("This bot already has a route for this workspace"));

          if (input.delivery === "reply") {
            const overlap = yield* sql`SELECT id FROM bot_channel_routes WHERE account_id=${input.accountId}::uuid
          AND deleted_at IS NULL AND delivery='reply' AND id<>${id}::uuid
          AND (channel_ids && ${input.channelIds}::text[] OR (direct_messages AND ${input.directMessages}))`;

            if (overlap.length)
              return yield* Effect.fail(
                new Invalid("Another bot already replies in these channels or direct messages"),
              );
          }

          const rows =
            yield* sql<RouteRow>`INSERT INTO bot_channel_routes(id,owner_user_id,bot_id,account_id,channel_ids,user_ids,
        direct_messages,mentions,observe,delivery,instructions) VALUES(${id}::uuid,${owner}::uuid,${input.botId}::uuid,
        ${input.accountId}::uuid,${[...new Set(input.channelIds)]}::text[],${[...new Set(input.userIds)]}::text[],
        ${input.directMessages},${input.mentions},${input.observe},${input.delivery},${input.instructions})
        ON CONFLICT(id) DO UPDATE SET channel_ids=excluded.channel_ids,user_ids=excluded.user_ids,
          direct_messages=excluded.direct_messages,mentions=excluded.mentions,observe=excluded.observe,
          delivery=excluded.delivery,instructions=excluded.instructions RETURNING *`;

          yield* sql`UPDATE bot_channel_messages m SET deleted=true FROM bot_channel_conversations c
            WHERE m.conversation_id=c.id AND c.route_id=${id}::uuid AND m.state='buffered'
            AND (NOT (m.author_id=ANY(${input.userIds}::text[])) OR NOT (
              c.channel_id=ANY(${input.channelIds}::text[]) OR (${input.directMessages} AND c.channel_id LIKE 'D%')))`;

          return routeView(rows[0]!);
        }),
      ),
    deleteRoute: (owner: string, id: string) =>
      sql`UPDATE bot_channel_routes SET deleted_at=now()
      WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid`.pipe(Effect.asVoid),
  };
}
