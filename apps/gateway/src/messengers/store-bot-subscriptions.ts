import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { BotTurn } from "../bots/types.ts";
import { Invalid, NotFound } from "../store/store.ts";
import type { messengerRoutes } from "./store-routes.ts";
import type { SaveMessengerRoute } from "./types.ts";

/** Subscription administration is authority from a private owner message, never channel content. */
export function botSubscriptions(sql: SqlClient.SqlClient, routes: ReturnType<typeof messengerRoutes>) {
  const requireOwnerTurn = (owner: string, turn: BotTurn) =>
    sql`SELECT t.id FROM bot_turns t JOIN bots b ON b.id=t.bot_id
      JOIN bot_messages m ON m.turn_id=t.id AND m.message_key='input'
      WHERE t.id=${turn.id}::uuid AND t.bot_id=${turn.bot_id}::uuid AND b.owner_user_id=${owner}::uuid
        AND t.status='running' AND t.lease_token=${turn.lease_token}::uuid AND t.lease_until>now()
        AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL
        AND t.conversation_id IS NULL AND t.routine_id IS NULL AND t.handoff_configuration IS NULL
        AND t.reply_to_bot_id IS NULL AND t.exchange_id IS NULL AND t.remote_recipient_ref IS NULL AND t.hops=0
        AND m.bot_id=t.bot_id AND m.sender_id='user' AND m.kind='message' AND m.exchange_id IS NULL`.pipe(
      Effect.flatMap((rows) =>
        rows.length
          ? Effect.void
          : Effect.fail(new Invalid("Messenger subscriptions require a private message from your owner")),
      ),
    );

  return {
    requireOwnerTurn,
    saveBotRoute: (owner: string, turn: BotTurn, input: Omit<SaveMessengerRoute, "botId">) =>
      Effect.gen(function* () {
        yield* requireOwnerTurn(owner, turn);
        const own = yield* routes.routes(owner, turn.bot_id);

        const existing = input.id
          ? own.find((r) => r.id === input.id)
          : own.find((r) => r.accountId === input.accountId);

        if (input.id && !existing) return yield* Effect.fail(new NotFound("Messenger subscription not found"));

        return yield* routes.saveRoute(owner, { ...input, botId: turn.bot_id, ...(existing && { id: existing.id }) });
      }),
    stopBotRoute: (owner: string, turn: BotTurn, id: string) =>
      Effect.gen(function* () {
        yield* requireOwnerTurn(owner, turn);
        const own = yield* routes.routes(owner, turn.bot_id);

        if (!own.some((r) => r.id === id)) return yield* Effect.fail(new NotFound("Messenger subscription not found"));
        yield* routes.deleteRoute(owner, id);

        return { stopped: true };
      }),
  };
}
