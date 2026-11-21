import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { requireOwnerBotTurn } from "../bots/owner-turn.ts";
import type { BotTurn } from "../bots/types.ts";
import { NotFound } from "../store/store.ts";
import type { messengerRoutes } from "./store-routes.ts";
import type { SaveMessengerRoute } from "./types.ts";

/** Subscription administration is authority from a private owner message, never channel content. */
export function botSubscriptions(sql: SqlClient.SqlClient, routes: ReturnType<typeof messengerRoutes>) {
  const requireOwnerTurn = (owner: string, turn: BotTurn) =>
    requireOwnerBotTurn(sql, owner, turn, "Messenger subscriptions require a private message from your owner");

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
