import { create, fromJson } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { AgentBus } from "./agent-bus.ts";
import { Scheduler } from "./scheduler.ts";
import { scheduleWorkerEligible } from "@canopy/domain";
import { titleContext } from "./thread-titles.ts";
import { BotsRuntime } from "../bots/runtime.ts";
import { botPlatform, describeBotTool, prepareBotTool } from "../bots/platform.ts";
import { GatewayUpdates } from "../updates/runtime.ts";
import { UpdatePersistence } from "../updates/persistence.ts";
import { coreDeliver } from "./core-commands.ts";
import { coreState, type GatewayCoreOptions } from "./core-context.ts";
import { coreStartThread } from "./core-threads.ts";
import { coreAnswer, corePublishInteraction } from "./core-interactions.ts";
import { coreQueueSteer, coreSendSteer, coreSteers } from "./core-messages.ts";
import { coreSpawnInstances } from "./core-models.ts";
import { coreWorkers } from "./core-providers.ts";
import { coreAutoTitle, coreUiThread } from "./core-titles.ts";
import { coreBroadcastThread, coreBroadcastTurn, coreLog, coreRun } from "./core-broadcast.ts";
import { corePublishSchedule } from "./core-schedules.ts";
import type { GatewayCore } from "./core.ts";
import { nameAutomationBranch, prepareScheduledWorkspace, prepareSpawnWorkspace } from "../worktrees/automation.ts";

export function createCoreBots(core: GatewayCore, options: GatewayCoreOptions): BotsRuntime {
  return new BotsRuntime({
    runtime: options.runtime,
    userId: options.userId,
    draining: () => core.updates?.draining ?? false,
    connectors: core.connectors,
    ...(options.botClock && { now: options.botClock }),
    ...(options.botModel && { model: options.botModel }),
    ...(options.log && { log: options.log }),
    platform: (turn, call) => botPlatform(core, options, turn, call),
    describeTool: (tool, args) => describeBotTool(core, tool, args),
    prepareTool: (turn, call) => prepareBotTool(core, options, turn, call),
    linkedTick: () => core.linkedAgents.tick(),
  });
}

export function createCoreBus(core: GatewayCore): AgentBus {
  return new AgentBus({
    linked: (request, call, caller) => core.linkedAgents.tool(request, call, caller),
    extend: (call, caller, result) => core.linkedAgents.extend(call, caller, result),
    run: (effect) => core[coreState].options.runtime.runPromise(effect),
    startThread: (row) => coreStartThread(core, row),
    prepareWorkspace: async (caller, args) => (await prepareSpawnWorkspace(core, caller, args)).request,
    nameWorkspace: (thread, prompt) => nameAutomationBranch(core, thread, prompt),
    queued: async (threadId, turn) => {
      await coreBroadcastTurn(core, threadId, turn.id); // re-read: the UI gets the turn with its source
      await core.pump(threadId);
    },
    steered: (steerId) => coreSendSteer(core, steerId),
    interaction: (interaction) => corePublishInteraction(core, interaction),
    requestSecret: (source, args) => core.secrets.request(source, args),
    interrupt: (threadId) => core.interrupt(threadId),
    answer: (by, request) => coreAnswer(core, by, request),
    broadcastThread: (threadId) => coreBroadcastThread(core, threadId),
    scheduleChanged: (scheduleId) => corePublishSchedule(core, scheduleId),
    spawnInstances: (thread) => coreSpawnInstances(core, thread),
    backgroundTask: (call, callerId) => core.backgroundTasks.tool(call, callerId),
    fallbackSteer: async (steerId) => {
      await coreQueueSteer(core, steerId, "the notification could not join its turn");
      await core.pump((await coreSteers(core, (s) => s.steer(steerId))).thread_id);
    },
  });
}

export function createCoreScheduler(core: GatewayCore, options: GatewayCoreOptions): Scheduler {
  return new Scheduler({
    run: (effect) => core[coreState].options.runtime.runPromise(effect),
    queued: async (threadId, turn) => {
      await coreBroadcastTurn(core, threadId, turn.id); // re-read: the UI gets the turn with its source
      await core.pump(threadId);
    },
    owner: options.instanceId,
    log: (message) => coreLog(core, message),
    changed: (scheduleId) => corePublishSchedule(core, scheduleId),
    prepareWorkspace: (request, userId, sourceId) => prepareScheduledWorkspace(core, request, userId, sourceId),
    eligibleWorkers: async (schedule) => {
      const spec = fromJson(ui.NewThreadScheduleSchema, schedule.new_thread!);

      return (await coreWorkers(core))
        .filter((w) => scheduleWorkerEligible(w, spec, spec.placement !== "specific"))
        .map((w) => w.id);
    },
    created: async ({ thread, command, newWorktree }, prompt) => {
      core.hub.publishOverview(
        create(ui.OverviewUpdateSchema, { change: { case: "thread", value: coreUiThread(core, thread) } }),
      );
      void coreDeliver(core, thread.worker_id!, command);
      coreAutoTitle(core, thread.id, titleContext({ text: prompt }));

      if (newWorktree) await nameAutomationBranch(core, thread, prompt);
    },
  });
}

export function createCoreUpdates(core: GatewayCore, options: GatewayCoreOptions): GatewayUpdates {
  return new GatewayUpdates({
    ...options.updates,
    idle: async () =>
      core[coreState].pumpAdmissions === 0 && core.bots.idle && ((await options.updates?.idle?.()) ?? true),
    drain: (value) => {
      options.updates?.drain?.(value);

      if (!value) {
        const deferred = [...core[coreState].updateDeferred];
        core[coreState].updateDeferred.clear();

        for (const threadId of deferred)
          void core.pump(threadId).catch(() => coreLog(core, `thread ${threadId}: queue resume failed`));
      }
    },
    persistence: new UpdatePersistence(options.runtime, options.userId),
    authenticate: (credential) => coreRun(core, (s) => s.authenticateWorker(credential)),
  });
}
