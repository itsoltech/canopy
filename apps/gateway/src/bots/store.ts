import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { botAccess } from "./store-access.ts";
import { botConfig } from "./store-config.ts";
import { botQueue } from "./store-queue.ts";
import { botMethods, botSelfUpdate } from "./store-bots.ts";
import { botConversation, botMcp } from "./store-conversation.ts";
import { botApprovals, botTurns } from "./store-turns.ts";
import { botDeliveries, botWakeups } from "./store-wakeups.ts";
import { botHarnessStore } from "./store-harness.ts";
import { botRules } from "./store-rules.ts";
import { botThreadApprovals } from "./thread-approvals.ts";
import { botExchange } from "./store-exchange.ts";
import { botDrafts } from "./drafts.ts";

export {
  botConfiguration,
  botView,
  MAX_BOTS_PER_USER,
  remoteUrl,
  requiredString,
  type WakeupRow,
} from "./store-views.ts";

function makeStore(sql: SqlClient.SqlClient, key: Buffer) {
  const access = botAccess(sql, key);
  const config = botConfig(sql, access);
  const queue = botQueue(sql, access);
  const core = { ...access, ...config, ...queue };

  return {
    handoffContext: access.handoffs.context,
    handoffFallback: access.handoffs.fallback,
    latestHandoff: access.handoffs.latest,
    owned: core.owned,
    active: core.active,
    save: core.save,
    enqueue: core.enqueue,
    finish: core.finish,
    changed: core.changed,
    fenced: core.fenced,
    servers: core.servers,
    resolvedServer: core.resolvedServer,
    ...queue.routines,
    ...botMethods(sql, core),
    ...botSelfUpdate(sql, core),
    ...botConversation(sql, core),
    ...botExchange(sql, core),
    ...botDrafts(sql, core),
    ...botMcp(sql, core),
    ...botTurns(sql, core),
    ...botApprovals(sql, core),
    ...botRules(sql, core),
    ...botThreadApprovals(sql),
    ...botWakeups(sql, core),
    ...botDeliveries(sql, core),
    ...botHarnessStore(sql, core),
  };
}

export class BotStore extends Context.Service<BotStore, ReturnType<typeof makeStore>>()("canopy/gateway/BotStore") {
  static readonly layer = (key: Buffer) =>
    Layer.effect(
      BotStore,
      Effect.gen(function* () {
        return makeStore(yield* SqlClient.SqlClient, key);
      }),
    );
}
