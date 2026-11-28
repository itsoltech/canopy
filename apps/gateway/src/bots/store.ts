import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { bots } from "@canopy/contracts";
import type { AgentBusArgs, AttachmentLimits } from "@canopy/domain";
import type { ThreadFileTransfer } from "../core/thread-file-transfer.ts";
import { setUserBotMessageReaction } from "./store-reactions.ts";
import { botMemoryAccess } from "./memory.ts";
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
import { slackTurnContext } from "../messengers/channel-context-read.ts";
import { conversationContext } from "../messengers/store-outbound.ts";
import { botPoll } from "./poll.ts";
import { settleChatSteer } from "./store-chat-steer.ts";
import { checkThreadFileRecipient, messageDelegatingBot } from "./thread-messages.ts";
import type { CallSource } from "../store/agent-bus-types.ts";
import { botExecutions } from "./bot-execution.ts";
import { botParked } from "./parked.ts";
import { refuseBotCommand, settleRemovedWorker } from "./store-harness.ts";
import { recheckTrigger, triggerDispatchable, workerBotLink } from "./trigger-current.ts";
import { triggerStore } from "./triggers.ts";
import { matchTriggerEvents } from "./trigger-matcher.ts";
import { flushTriggerBatches } from "./trigger-flush.ts";

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
    setUserMessageReaction: (owner: string, request: bots.SetBotMessageReactionRequest) =>
      setUserBotMessageReaction(sql, access, owner, request),
    memoryAccess: (owner: string, turn: import("./types.ts").BotTurn) => botMemoryAccess(sql, owner, turn),
    slackTurnContext: (owner: string, turn: import("./types.ts").BotTurn, includeBackground = true) =>
      slackTurnContext(sql, owner, turn, includeBackground),
    conversationContext: (turn: import("./types.ts").BotTurn) => conversationContext(sql, turn),
    originEnabled: core.originEnabled,
    checkThreadFileRecipient: (owner: string, source: CallSource) => checkThreadFileRecipient(sql, owner, source),
    messageDelegatingBot: (
      owner: string,
      source: CallSource,
      args: AgentBusArgs["message_delegating_bot"],
      limits?: AttachmentLimits,
      transfer?: ThreadFileTransfer,
    ) => messageDelegatingBot(sql, core, owner, source, args, limits, transfer),
    interruptedTurns: (owner: string, ids: string[]) =>
      sql<{ id: string }>`SELECT t.id FROM bot_turns t JOIN bots b ON b.id=t.bot_id
      WHERE b.owner_user_id=${owner}::uuid AND t.id=ANY(${ids}::uuid[]) AND t.status='interrupted'`.pipe(
        Effect.map((rows) => new Set(rows.map((t) => t.id))),
      ),
    poll: (owner: string, now: Date) => botPoll(sql, owner, now),
    executions: (owner: string) => botExecutions(sql, owner),
    handoffContext: access.handoffs.context,
    handoffFallback: access.handoffs.fallback,
    latestHandoff: access.handoffs.latest,
    owned: core.owned,
    active: core.active,
    save: core.save,
    enqueue: core.enqueue,
    submitInput: core.submitInput,
    rejectChatSteer: (input: import("./types.ts").BotSteerDelivery) =>
      settleChatSteer(sql, input.botId, input.turnId, input.inputId, false),
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
    ...botParked(sql, core),
    recheckTrigger: (owner: string, turn: import("./types.ts").BotTurn, now: Date) =>
      recheckTrigger(sql, owner, turn, now),
    triggerDispatchable: (commandId: string, now: Date) => triggerDispatchable(sql, commandId, now),
    workerBotLink: (workerId: string) => workerBotLink(sql, workerId),
    refuseBotCommand: (id: string, workerId: string, epoch: bigint) => refuseBotCommand(sql, id, workerId, epoch),
    settleRemovedWorker: (turnId: string, workerId: string) => settleRemovedWorker(sql, turnId, workerId),
    ...queryMethods("bots.queue", triggerStore(sql, core)),
    // Scheduled background work: due routines, then parked cards whose decision window closed.
    deliverRoutines: (user: string, now: Date) =>
      queue.routines
        .deliverRoutines(user, now)
        .pipe(
          Effect.andThen(botParked(sql, core).expireParked(user)),
          Effect.andThen(matchTriggerEvents(sql, user, now)),
          Effect.andThen(flushTriggerBatches(sql, core, user, now)),
        ),
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
