import { create, fromJson } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { toUiSteer, toUiTurn } from "../store/index.ts";
import { AgentBus } from "./agent-bus.ts";
import { Scheduler } from "./scheduler.ts";
import { scheduleWorkerEligible } from "@canopy/domain";
import { titleContext } from "./thread-titles.ts";
import { BotsRuntime } from "../bots/runtime.ts";
import { botPlatform, describeBotTool, prepareBotTool } from "../bots/platform.ts";
import { GatewayUpdates } from "../updates/runtime.ts";
import { githubReleaseFetch } from "../github/release-fetch.ts";
import { UpdatePersistence } from "../updates/persistence.ts";
import { coreDeliver, coreRedeliver } from "./core-commands.ts";
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
import { runBotHarness } from "./bot-harness.ts";
import { answerBotThreadApproval } from "./bot-thread-approval.ts";
import { linkedBotThreadApprovals } from "../computers/bot-thread-approvals.ts";
import { publishThreadImages } from "./image-publication.ts";
import { importImageReply } from "./image-markdown.ts";

export function createCoreBots(core: GatewayCore, options: GatewayCoreOptions): BotsRuntime {
  return new BotsRuntime({
    runtime: options.runtime,
    userId: options.userId,
    draining: () => core.updates?.draining ?? false,
    connectors: core.connectors,
    harness: (input) => runBotHarness(core, input),
    deliverInterrupt: (workerId) => coreRedeliver(core, workerId),
    ...(options.botClock && { now: options.botClock }),
    ...(options.botModel && { model: options.botModel }),
    ...(options.log && { log: options.log }),
    platform: (turn, call) => botPlatform(core, options, turn, call),
    describeTool: (tool, args) => describeBotTool(core, tool, args),
    prepareTool: (turn, call) => prepareBotTool(core, options, turn, call),
    linkedTick: () => core.linkedAgents.tick(),
    answerThreadApproval: (request) => answerBotThreadApproval(core, request),
    linkedThreadApprovals: (botId) => linkedBotThreadApprovals(core.linkedAgents, botId),
  });
}

export function createCoreBus(core: GatewayCore): AgentBus {
  return new AgentBus({
    ownerUserId: core[coreState].options.userId,
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
    showImages: (source, caller, args) => publishThreadImages(core, source, caller, args),
    importImageReply: (source, caller, itemId) => importImageReply(core, source, caller, itemId),
    interrupt: (threadId) => core.interrupt(threadId),
    answer: (by, request) => coreAnswer(core, by, request),
    broadcastThread: (threadId) => coreBroadcastThread(core, threadId),
    inputsChanged: async (threadId) => {
      for (const turn of await coreRun(core, (s) => s.turnsOf(threadId)))
        if (turn.withdrawn === "consumed")
          core.hub.publishThread(
            threadId,
            create(ui.ThreadUpdateSchema, { change: { case: "turn", value: toUiTurn(turn) } }),
          );

      for (const steer of await coreSteers(core, (s) => s.ofThread(threadId)))
        if (steer.status === "failed")
          core.hub.publishThread(
            threadId,
            create(ui.ThreadUpdateSchema, { change: { case: "steer", value: toUiSteer(steer) } }),
          );
    },
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
  const persistence = new UpdatePersistence(options.runtime, options.userId);
  const releaseFetch = githubReleaseFetch(core.github, () => persistence.admin(), options.updates?.source?.fetch);

  return new GatewayUpdates({
    ...options.updates,
    source: {
      ...options.updates?.source,
      fetch: releaseFetch,
      cacheScope: releaseFetch.cacheScope,
    },
    departure: (state, target) => core.departures.announce(state, target),
    recovered: (state, reason, target) => core.departures.recover(state, reason, target),
    bundled: core.role === "desktop",
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
    persistence,
    changed: () => core.feeds.updatesChanged(),
    authenticate: (credential) => coreRun(core, (s) => s.authenticateWorker(credential)),
  });
}
