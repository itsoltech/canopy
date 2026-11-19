import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { GatewayStore, toUiTurn } from "../store/index.ts";
import type { BotTurn, StoredCall } from "../bots/types.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { corePublishDeliveries } from "./core-messages.ts";
import { coreWorkers } from "./core-providers.ts";
import { coreUiThread } from "./core-titles.ts";
import { decorateOrigins, ORIGIN_CACHE_MS, workspaceOriginsDue } from "./workspace-origins.ts";
import { threadDiagnostic } from "./thread-diagnostics.ts";
import { coreBroadcastGoal } from "./core-goals.ts";
import { publishWorkerThreadLifecycle } from "./worker-thread-lifecycle.ts";

export async function coreBroadcastThread(hostContext: GatewayCore, threadId: string): Promise<void> {
  const row = await coreRun(hostContext, (s) => s.thread(threadId, true, true));
  publishWorkerThreadLifecycle(hostContext, row);

  if ((row.archived_at || row.deleted_at) && row.goal_status === "paused")
    await coreBroadcastGoal(hostContext, threadId);
  const thread = coreUiThread(hostContext, row);
  hostContext.hub.publishThread(threadId, create(ui.ThreadUpdateSchema, { change: { case: "thread", value: thread } }));
  hostContext.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "thread", value: thread } }));
}

export async function coreBroadcastTurn(
  hostContext: GatewayCore,
  threadId: string,
  turnId: string,
  phase?: "started" | "finished",
): Promise<void> {
  const turn = (await coreRun(hostContext, (s) => s.turnsOf(threadId, [turnId])))[0];

  if (!turn) return;

  if (phase)
    threadDiagnostic(hostContext, phase === "started" ? "turn_started" : "turn_finished", {
      threadId,
      turnId,
      source: turn.trigger,
      status: phase === "started" ? "running" : turn.status,
    });
  hostContext.hub.publishThread(
    threadId,
    create(ui.ThreadUpdateSchema, { change: { case: "turn", value: toUiTurn(turn) } }),
  );

  // Started by another thread's agent (spawn_thread, send_message): its card follows this turn.
  if (turn.agent_call_id) await corePublishDeliveries(hostContext, { turnId });
}

/** Registration and configuration reconcile placements. Status reports can be local or fleet-wide. */
export async function coreBroadcastWorkers(
  hostContext: GatewayCore,
  scope: "placements" | "status" = "placements",
  workerId?: string,
): Promise<void> {
  for (const worker of await coreWorkers(hostContext)) {
    if (workerId && worker.id !== workerId) continue;
    hostContext.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "worker", value: worker } }));
  }

  const state = hostContext[coreState];
  const placements = scope === "placements";

  if (!placements) {
    if (Date.now() < state.nextStatusOriginCheck || (workerId && !workspaceOriginsDue(hostContext))) return;
    state.nextStatusOriginCheck = Infinity;
  }

  const changed = state.pendingOriginProjects;
  state.pendingOriginProjects = new Set();

  try {
    const projects = await coreRun(hostContext, (s) => s.listProjects(state.options.userId));
    await decorateOrigins(hostContext, projects, (id) => changed?.add(id));

    for (const project of projects)
      if (placements || !changed || changed.has(project.id))
        hostContext.hub.publishOverview(
          create(ui.OverviewUpdateSchema, { change: { case: "project", value: project } }),
        );

    if (!placements) state.nextStatusOriginCheck = Date.now() + ORIGIN_CACHE_MS;
  } catch (cause) {
    // A partial refresh may already have persisted an origin. Replay on the next successful pass.
    state.pendingOriginProjects = undefined;

    if (!placements) state.nextStatusOriginCheck = Date.now() + 1000;
    throw cause;
  }
}

export function coreRun<A, E>(
  hostContext: GatewayCore,
  use: (store: GatewayStore["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  return hostContext[coreState].actions.run(GatewayStore.use(use));
}

export function coreLog(hostContext: GatewayCore, message: string): void {
  hostContext[coreState].options.log?.(message);
}

export interface CoreBroadcastMethods {
  threadsChanged(ids: readonly string[]): Promise<void>;
  botAction<A>(turn: BotTurn, call: StoredCall, perform: () => Promise<A>): Promise<A>;
}

export const coreBroadcastMethods: CoreBroadcastMethods = {
  /** Threads changed outside the core's own actions (a move to or from a linked computer). */
  async threadsChanged(this: GatewayCore, ids: readonly string[]): Promise<void> {
    for (const id of ids) await coreBroadcastThread(this, id).catch(() => undefined);
  },

  /** Reuse UI validation/mutations inside the bot's fenced, idempotent SQL action. */
  botAction<A>(this: GatewayCore, turn: BotTurn, call: StoredCall, perform: () => Promise<A>): Promise<A> {
    return this[coreState].actions.action(turn, call, perform);
  },
};
