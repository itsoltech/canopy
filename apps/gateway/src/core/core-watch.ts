import { create, fromBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { NotFound, toUiDelivery, toUiGoal, toUiSchedule, toUiSteer, toUiTurn, turnEffort } from "../store/index.ts";
import { coreState } from "./core-context.ts";
import { coreCheckProvider, coreStartThread } from "./core-threads.ts";
import type { GatewayCore } from "./core.ts";
import { coreRun } from "./core-broadcast.ts";
import { coreGoals } from "./core-goals.ts";
import { coreSteers } from "./core-messages.ts";
import { coreCheckModel, coreProfileModels } from "./core-models.ts";
import { coreBus } from "./core-schedules.ts";
import { coreUiThread } from "./core-titles.ts";

export interface CoreWatchMethods {
  movedHistory(threadId: string): Promise<ui.ThreadSnapshot | undefined>;
  createMovedThread(request: ui.CreateThreadRequest, id: string, prepare: () => Promise<void>): Promise<void>;
  watchThread(threadId: string, signal: AbortSignal): AsyncGenerator<ui.ThreadUpdate>;
  watchOverview(signal: AbortSignal, includeSnapshot?: boolean): AsyncGenerator<ui.OverviewUpdate>;
}

export const coreWatchMethods: CoreWatchMethods = {
  /** The history a thread had on the linked computer it moved from (docs/linked-computers.md, stage 8). */
  async movedHistory(this: GatewayCore, threadId: string): Promise<ui.ThreadSnapshot | undefined> {
    const rows = await this[coreState].actions.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<{
          history: Uint8Array;
        }>`SELECT history FROM computer_moved_threads WHERE thread_id = ${threadId}::uuid`;
      }),
    );

    return rows[0] ? fromBinary(ui.ThreadSnapshotSchema, rows[0].history) : undefined;
  },

  /**
   * A thread moved here keeps its id. `prepare` writes its history and handoff note before the worker starts
   * its new session; a retry after a restart finds the thread and repeats only the idempotent steps.
   */
  async createMovedThread(
    this: GatewayCore,
    request: ui.CreateThreadRequest,
    id: string,
    prepare: () => Promise<void>,
  ): Promise<void> {
    const existing = await coreRun(this, (s) => s.thread(id)).catch(() => undefined);

    if (existing) {
      await prepare();

      if (existing.status === "creating" && !existing.provider_thread_id)
        await coreStartThread(this, await coreRun(this, (s) => s.thread(id)));

      return;
    }

    await coreCheckProvider(this, request);

    const where = {
      workspaceId: request.workspaceId,
      provider: request.provider,
      profileId: request.providerProfileId,
    };

    // The model may not exist here: the thread then continues with the instance's default.
    const known = await coreCheckModel(this, where, request.model, request.effort).then(
      () => true,
      () => false,
    );

    const chosen = known ? request : create(ui.CreateThreadRequestSchema, { ...request, model: "", effort: "" });
    const effort = turnEffort((await coreProfileModels(this, where)).models, chosen.model, chosen.effort);
    await coreRun(this, (s) => s.createThread(this[coreState].options.userId, { ...chosen, effort }, id));
    await prepare();
    await coreStartThread(this, await coreRun(this, (s) => s.thread(id)));
  },

  /** Snapshot first, then live updates after it (subscribe before reading, skip what the snapshot has). */
  async *watchThread(this: GatewayCore, threadId: string, signal: AbortSignal): AsyncGenerator<ui.ThreadUpdate> {
    const subscription = this.hub.subscribeThread(threadId);
    signal.addEventListener("abort", () => subscription.close(), { once: true });

    try {
      const snapshot = await coreRun(this, (s) => s.snapshot(threadId));

      if (snapshot.thread.owner_user_id !== this[coreState].options.userId) throw new NotFound("thread not found");
      // A thread moved here from a linked computer shows its history there first (stage 8).
      const moved = await this.movedHistory(threadId);
      const goal = await coreGoals(this, (s) => s.latest(threadId)).then((goal) => goal && toUiGoal(goal));
      yield create(ui.ThreadUpdateSchema, {
        change: {
          case: "snapshot",
          value: {
            thread: coreUiThread(this, snapshot.thread),
            turns: [...(moved?.turns ?? []), ...snapshot.turns.map(toUiTurn)],
            items: [...(moved?.items ?? []), ...snapshot.items],
            interactions: snapshot.interactions,
            secrets: await coreRun(this, (s) => s.threadSecrets(this[coreState].options.userId, threadId)),
            notices: [...(moved?.notices ?? []), ...snapshot.notices],
            schedules: (
              await coreBus(this, (s) =>
                s.schedulesFor({ ownerUserId: this[coreState].options.userId, threadId, includeFinished: false }),
              )
            ).map(toUiSchedule),
            steers: [...(moved?.steers ?? []), ...(await coreSteers(this, (s) => s.ofThread(threadId))).map(toUiSteer)],
            busDeliveries: [
              ...(moved?.busDeliveries ?? []),
              ...(await coreBus(this, (s) => s.deliveries({ sourceThreadId: threadId }))).map(toUiDelivery),
            ],
            ...(goal
              ? { goal }
              : moved?.goal && ["achieved", "cancelled"].includes(moved.goal.status) && { goal: moved.goal }),
            lastSeq: snapshot.lastSeq,
          },
        },
      });

      for await (const update of subscription.updates) {
        if (update.change.case === "event" && update.change.value.seq <= snapshot.lastSeq) continue;
        yield update;
      }
    } finally {
      subscription.close();
    }
  },

  async *watchOverview(
    this: GatewayCore,
    signal: AbortSignal,
    includeSnapshot = false,
  ): AsyncGenerator<ui.OverviewUpdate> {
    const subscription = this.hub.subscribeOverview();
    signal.addEventListener("abort", () => subscription.close(), { once: true });

    try {
      if (includeSnapshot) {
        const [overview, threads] = await Promise.all([this.overview(), this.listThreads("", false, false)]);
        yield create(ui.OverviewUpdateSchema, { change: { case: "mobileSnapshot", value: { overview, threads } } });
      }

      yield* subscription.updates;
    } finally {
      subscription.close();
    }
  },
};
