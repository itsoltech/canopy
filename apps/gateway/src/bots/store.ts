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
import { queryMethods } from "../diagnostics/query-context.ts";
import { botPoll } from "./poll.ts";

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
  const { routines, ...methods } = botQueue(sql, access);
  const queue = { ...queryMethods("bots.queue", methods), routines: queryMethods("bots.queue", routines) };
  const core = { ...access, ...config, ...queue };

  return {
    poll: (owner: string, now: Date) => botPoll(sql, owner, now),
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
    ...queryMethods("bots.harness", botHarnessStore(sql, core)),
  };
}

export class BotStore extends Context.Service<BotStore, ReturnType<typeof makeStore>>()("canopy/gateway/BotStore") {
  static readonly layer = (key: Buffer) =>
    Layer.effect(
      BotStore,
      Effect.gen(function* () {
        return queryMethods("bots.store", makeStore(yield* SqlClient.SqlClient, key));
      }),
    );
}
