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
import { decorateOrigins } from "./workspace-origins.ts";

export async function coreBroadcastThread(hostContext: GatewayCore, threadId: string): Promise<void> {
  const thread = coreUiThread(hostContext, await coreRun(hostContext, (s) => s.thread(threadId, true)));
  hostContext.hub.publishThread(threadId, create(ui.ThreadUpdateSchema, { change: { case: "thread", value: thread } }));
  hostContext.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "thread", value: thread } }));
}

export async function coreBroadcastTurn(hostContext: GatewayCore, threadId: string, turnId: string): Promise<void> {
  const turn = (await coreRun(hostContext, (s) => s.turnsOf(threadId))).find((t) => t.id === turnId);

  if (!turn) return;
  hostContext.hub.publishThread(
    threadId,
    create(ui.ThreadUpdateSchema, { change: { case: "turn", value: toUiTurn(turn) } }),
  );

  // Started by another thread's agent (spawn_thread, send_message): its card follows this turn.
  if (turn.agent_call_id) await corePublishDeliveries(hostContext, { turnId });
}

export async function coreBroadcastWorkers(hostContext: GatewayCore): Promise<void> {
  for (const worker of await coreWorkers(hostContext)) {
    hostContext.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "worker", value: worker } }));
  }

  // A newly configured worker becomes a scratch placement without a page reload.
  const projects = await coreRun(hostContext, (s) => s.listProjects(hostContext[coreState].options.userId));
  await decorateOrigins(hostContext, projects);

  for (const project of projects)
    hostContext.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "project", value: project } }));
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
