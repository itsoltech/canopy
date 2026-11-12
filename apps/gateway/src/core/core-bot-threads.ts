import { create, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { GatewayStore } from "../store/index.ts";
import { BotStore } from "../bots/store.ts";
import type { BotTurn, StoredCall } from "../bots/types.ts";
import { coreRedeliver } from "./core-commands.ts";
import { coreState, InvalidError } from "./core-context.ts";
import { corePublishSteer } from "./core-messages.ts";
import type { GatewayCore } from "./core.ts";
import { coreBroadcastThread } from "./core-broadcast.ts";
import { SqlClient } from "effect/sql";
import { copyConversationFiles, forwardedNotice } from "./bot-files.ts";
import { botThreadPermission } from "../bots/thread-permission.ts";

export interface CoreBotThreadsMethods {
  startBotThread(
    turn: BotTurn,
    call: StoredCall,
    request: ui.CreateThreadRequest,
  ): Promise<{ thread_id: string; turn_id: string | undefined; worker_id: string; thread?: JsonValue }>;
  watchBotThread(turn: BotTurn, call: StoredCall, threadId: string): Promise<string | undefined>;
  botThreadQueued(threadId: string): Promise<void>;
  sendBotThreadMessage(
    turn: BotTurn,
    call: StoredCall,
    threadId: string,
    text: string,
    delivery: string,
  ): Promise<{ thread_id: string; turn_id: string; steer_id: string; delivery: string; worker_id: string }>;
  updateBotThread(
    turn: BotTurn,
    call: StoredCall,
    request: ui.UpdateThreadRequest,
  ): Promise<{ thread_id: string; title: string; model: string; effort: string }>;
  archiveBotThread(
    turn: BotTurn,
    call: StoredCall,
    threadId: string,
  ): Promise<{ thread_id: string; archived: boolean }>;
}

export const coreBotThreadsMethods: CoreBotThreadsMethods = {
  /** Bot actions use the UI's validation, with creation, worker outbox, watch and result in one transaction. */
  async startBotThread(this: GatewayCore, turn: BotTurn, call: StoredCall, request: ui.CreateThreadRequest) {
    return this.botAction(turn, call, async () => {
      const initialAttachmentIds = await copyConversationFiles(this, turn, call);
      const bot = await this.bots.get(turn.bot_id);
      const defaults = await this.settings();
      const permissionMode = botThreadPermission(bot.configuration!, defaults.user?.threadDefaults?.permissionMode);

      const thread = await this.createThread(
        create(ui.CreateThreadRequestSchema, { ...request, initialAttachmentIds, permissionMode }),
        undefined,
        false,
        {},
      );

      await this[coreState].actions.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO bot_started_threads(thread_id, bot_id) VALUES (${thread.id}::uuid, ${turn.bot_id}::uuid) ON CONFLICT DO NOTHING`;
        }),
      );
      const turnId = await this.watchBotThread(turn, call, thread.id);
      await forwardedNotice(this, turn, call, thread.title);

      return {
        thread_id: thread.id,
        turn_id: turnId,
        worker_id: thread.workerId,
        ...(request.forkThreadId && { thread: toJson(ui.ThreadSchema, thread) }),
      };
    });
  },

  async watchBotThread(
    this: GatewayCore,
    turn: BotTurn,
    call: StoredCall,
    threadId: string,
  ): Promise<string | undefined> {
    return this[coreState].actions.run(
      BotStore.use((bots) =>
        GatewayStore.use((store) =>
          Effect.gen(function* () {
            const target = (yield* store.turnsOf(threadId))[0];

            if (target) yield* bots.watchThread(turn, call, threadId, target.id);

            return target?.id;
          }),
        ),
      ),
    );
  },

  /** Publishes and dispatches a bot's atomically queued message after its commit. */
  async botThreadQueued(this: GatewayCore, threadId: string): Promise<void> {
    await coreBroadcastThread(this, threadId);
    await this.pump(threadId);
  },

  async sendBotThreadMessage(
    this: GatewayCore,
    turn: BotTurn,
    call: StoredCall,
    threadId: string,
    text: string,
    delivery: string,
  ) {
    if (delivery !== "queue" && delivery !== "steer") throw new InvalidError("delivery must be queue or steer");

    const result = await this.botAction(turn, call, async () => {
      const thread = await this.getThread(threadId);
      const attachmentIds = await copyConversationFiles(this, turn, call);

      const sent = await this.sendMessage(
        create(ui.SendMessageRequestSchema, {
          threadId,
          text,
          attachmentIds,
          clientRequestId: call.id,
          delivery: delivery === "steer" ? ui.MessageDelivery.STEER : ui.MessageDelivery.QUEUE,
        }),
      );

      const target = sent.steer?.turnId || sent.turn?.id;

      if (!target) throw new InvalidError("The message did not start a turn. Send a message without commands.");
      await this[coreState].actions.run(
        BotStore.use((bots) =>
          sent.steer
            ? bots.watchSteer(turn, call, threadId, sent.steer.id)
            : bots.watchThread(turn, call, threadId, target),
        ),
      );
      await forwardedNotice(this, turn, call, thread.title);

      return {
        thread_id: threadId,
        turn_id: target,
        steer_id: sent.steer?.id ?? "",
        delivery: sent.steer ? "steer" : "queue",
        worker_id: thread.workerId,
      };
    });

    if (result.delivery === "steer") {
      await coreRedeliver(this, result.worker_id);
      await corePublishSteer(this, result.steer_id);
    } else await this.botThreadQueued(threadId);

    return result;
  },

  async updateBotThread(this: GatewayCore, turn: BotTurn, call: StoredCall, request: ui.UpdateThreadRequest) {
    return this.botAction(turn, call, async () => {
      const thread = await this.updateThread(request);

      return { thread_id: thread.id, title: thread.title, model: thread.model, effort: thread.effort };
    });
  },

  async archiveBotThread(this: GatewayCore, turn: BotTurn, call: StoredCall, threadId: string) {
    const user = this[coreState].options.userId;

    const result = await this[coreState].options.runtime.runPromise(
      BotStore.use((bots) =>
        bots.action(
          turn,
          call,
          GatewayStore.use((store) =>
            Effect.gen(function* () {
              const changed = yield* store.setThreadArchived(user, threadId, true);

              return {
                thread_id: threadId,
                archived: true,
                ids: changed.ids,
                workers: changed.commands.map((c) => c.workerId),
              };
            }),
          ),
        ),
      ),
    );

    for (const worker of result.workers) await coreRedeliver(this, worker);

    for (const id of result.ids) await coreBroadcastThread(this, id);

    return { thread_id: threadId, archived: true };
  },
};
