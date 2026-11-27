import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { messengerAccounts } from "./store-accounts.ts";
import { messengerRoutes } from "./store-routes.ts";
import { messengerIngest } from "./store-ingest.ts";
import type { BotTurn } from "../bots/types.ts";
import { readMessengerHistory, type HistorySelection } from "./store-history.ts";
import { messengerDispatch } from "./store-dispatch.ts";
import { messengerOutbound } from "./store-outbound.ts";
import { messengerOutboundFiles } from "./store-outbound-files.ts";
import { botSubscriptions } from "./store-bot-subscriptions.ts";

export * from "./types.ts";

function makeStore(sql: SqlClient.SqlClient, key: Buffer) {
  const accounts = messengerAccounts(sql, key);
  const { owned: _owned, fenced: _fenced, ...publicAccounts } = accounts;
  const routes = messengerRoutes(sql, accounts);

  return {
    ...publicAccounts,
    ...routes,
    ...botSubscriptions(sql, routes),
    readHistory: (owner: string, turn: BotTurn, selection: HistorySelection) =>
      readMessengerHistory(sql, owner, turn, selection),
    ingest: messengerIngest(sql, accounts),
    ...messengerDispatch(sql),
    ...messengerOutbound(sql, accounts),
    ...messengerOutboundFiles(sql),
  };
}

export class MessengerStore extends Context.Service<MessengerStore, ReturnType<typeof makeStore>>()(
  "canopy/gateway/MessengerStore",
) {
  static readonly layer = (key: Buffer) =>
    Layer.effect(
      MessengerStore,
      Effect.gen(function* () {
        return makeStore(yield* SqlClient.SqlClient, key);
      }),
    );
}
