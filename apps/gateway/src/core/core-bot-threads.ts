import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { GatewayStore, SteerStore } from "../store/index.ts";
import { BotStore } from "../bots/store.ts";
import type { BotTurn, StoredCall } from "../bots/types.ts";
import { coreRedeliver } from "./core-commands.ts";
import { coreState, InvalidError, TTL } from "./core-context.ts";
import { corePublishSteer } from "./core-messages.ts";
import type { GatewayCore } from "./core.ts";
import { coreBroadcastThread } from "./core-broadcast.ts";

export interface CoreBotThreadsMethods {
  startBotThread(
    turn: BotTurn,
    call: StoredCall,
    request: ui.CreateThreadRequest,
  ): Promise<{ thread_id: string; turn_id: string | undefined; worker_id: string }>;
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
      const thread = await this.createThread(request);
      const turnId = await this.watchBotThread(turn, call, thread.id);

      return { thread_id: thread.id, turn_id: turnId, worker_id: thread.workerId };
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
    const user = this[coreState].options.userId;

    const result = await this[coreState].options.runtime.runPromise(
      BotStore.use((bots) =>
        bots.action(
          turn,
          call,
          Effect.gen(function* () {
            const store = yield* GatewayStore;
            const row = yield* store.thread(threadId);

            if (row.owner_user_id !== user || row.archived_at || !row.worker_id)
              return yield* Effect.fail(new InvalidError("thread not found or unavailable"));
            const running = delivery === "steer" ? yield* store.runningTurn(threadId) : undefined;

            if (running) {
              const steer = yield* SteerStore.use((s) =>
                s.create({
                  threadId,
                  turnId: running.id,
                  text,
                  userId: user,
                  clientRequestId: call.id,
                  model: "",
                  effort: "",
                  permissionMode: "",
                }),
              );

              yield* bots.watchSteer(turn, call, threadId, steer.id);
              yield* store.enqueueCommand({
                workerId: row.worker_id,
                threadId,
                ttlSeconds: TTL.steerTurn,
                command: {
                  commandId: steer.id,
                  kind: {
                    case: "steerTurn",
                    value: { threadId, turnId: running.id, inputId: steer.id, input: { text } },
                  },
                },
              });

              return {
                thread_id: threadId,
                turn_id: running.id,
                steer_id: steer.id,
                delivery: "steer",
                worker_id: row.worker_id,
              };
            }

            const target = yield* store.enqueueTurn({ threadId, text, userId: user, clientRequestId: call.id });
            yield* bots.watchThread(turn, call, threadId, target.id);

            return {
              thread_id: threadId,
              turn_id: target.id,
              steer_id: "",
              delivery: "queue",
              worker_id: row.worker_id,
            };
          }),
        ),
      ),
    );

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
