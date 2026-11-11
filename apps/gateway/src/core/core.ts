import { CliImports } from "../imports/index.ts";
import { GitHubAccounts } from "../github/service.ts";
import { GitHubDetection } from "../github/detection.ts";
import { Diagnostics } from "../diagnostics/service.ts";
import { create } from "@bufbuild/protobuf";
import { createCoreBots, createCoreBus, createCoreScheduler, createCoreUpdates } from "./core-composition.ts";
import { ui } from "@canopy/contracts";

import { SettingsStore } from "../store/index.ts";
import type { WorkerLink } from "../worker-link/index.ts";
import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentLimits } from "@canopy/domain";
import { AgentBus } from "./agent-bus.ts";
import { BackgroundTasks } from "./background-tasks.ts";
import { Hub } from "./hub.ts";
import { OwnerFeeds } from "./owner-feeds.ts";
import { Scheduler } from "./scheduler.ts";
import { BotsRuntime } from "../bots/runtime.ts";
import { ThreadSecrets } from "./thread-secrets.ts";
import { ActionContext } from "./action-context.ts";
import { ConnectorsRuntime } from "../connectors/runtime.ts";
import { WorkerAdministration } from "./worker-administration.ts";
import { MobileDevices } from "./mobile-devices.ts";
import { DesktopControl } from "../desktop-updates/control.ts";
import { LocalAppControl } from "../desktop-updates/local.ts";
import { DesktopUpdateStore } from "../desktop-updates/store.ts";
import { GatewayUpdates } from "../updates/runtime.ts";
import { createGatewayDepartures, type GatewayDepartures } from "../updates/departures.ts";
import { UpdateCenter } from "../updates/center.ts";
import { createUpdateCenter } from "../updates/center-composition.ts";
import { WorkerSsh } from "./worker-ssh.ts";
import { CliTools } from "./cli-tools.ts";
import { ProviderAccounts } from "./provider-accounts.ts";
import { AgentEnvironment } from "../agent-environment/service.ts";
import type { LinkedComputers } from "../computers/runtime.ts";
import type { NetworkAccess } from "../network/network.ts";
import { LinkedAgents } from "../computers/agents.ts";
import type { GatewayRole } from "../role.ts";
import { coreState, type GatewayCoreOptions } from "./core-context.ts";
import { createCoreWorkerLink } from "./core-workers.ts";
import { corePublishInteraction } from "./core-interactions.ts";
import { coreSendSteer } from "./core-messages.ts";
import { coreAttachmentsMethods, type CoreAttachmentsMethods } from "./core-attachments.ts";
import { coreBotThreadsMethods, type CoreBotThreadsMethods } from "./core-bot-threads.ts";
import {
  coreBroadcastMethods,
  coreBroadcastTurn,
  coreBroadcastWorkers,
  coreLog,
  coreRun,
  type CoreBroadcastMethods,
} from "./core-broadcast.ts";
import { GatewayCoreState } from "./core-context.ts";
import { coreGoalsMethods, coreStopTask, type CoreGoalsMethods } from "./core-goals.ts";
import { coreInteractionsMethods, type CoreInteractionsMethods } from "./core-interactions.ts";
import { coreMentionsMethods, type CoreMentionsMethods } from "./core-mentions.ts";
import { coreMessagesMethods, type CoreMessagesMethods } from "./core-messages.ts";
import { coreModelsMethods, type CoreModelsMethods } from "./core-models.ts";
import { coreProjectsMethods, type CoreProjectsMethods } from "./core-projects.ts";
import { coreProvidersMethods, type CoreProvidersMethods } from "./core-providers.ts";
import { coreQueueMethods, type CoreQueueMethods } from "./core-queue.ts";
import { coreSchedulesMethods, type CoreSchedulesMethods } from "./core-schedules.ts";
import { coreSettingsMethods, type CoreSettingsMethods } from "./core-settings.ts";
import { coreThreadsMethods, type CoreThreadsMethods } from "./core-threads.ts";
import { coreTitlesMethods, type CoreTitlesMethods } from "./core-titles.ts";
import { coreWatchMethods, type CoreWatchMethods } from "./core-watch.ts";
import { coreWorkLoopMethods, type CoreWorkLoopMethods } from "./core-work-loop.ts";
import { coreWorktreesMethods, type CoreWorktreesMethods } from "../worktrees/core-worktrees.ts";
import { coreWorktreeLifecycleMethods, type CoreWorktreeLifecycleMethods } from "../worktrees/core-lifecycle.ts";
import { WorktreeCleanupSchedule } from "../worktrees/cleanup-schedule.ts";

export {
  describeError,
  InvalidError,
  UnavailableError,
  type CoreRuntime,
  type CoreServices,
  type GatewayCoreOptions,
} from "./core-context.ts";

const createCoreGitHub = (core: GatewayCore, options: GatewayCoreOptions) =>
  new GitHubAccounts(options.runtime, options.userId, options.github, (ids) => core.threadsChanged(ids));

export class GatewayCore {
  readonly diagnostics: Diagnostics;
  readonly accounts = new ProviderAccounts(this);
  readonly role: GatewayRole;
  readonly [coreState] = new GatewayCoreState();
  declare sweep: CoreWorkLoopMethods["sweep"];
  declare startSweep: CoreWorkLoopMethods["startSweep"];
  declare stopSweep: CoreWorkLoopMethods["stopSweep"];
  declare pump: CoreWorkLoopMethods["pump"];
  declare reorderQueuedTurns: CoreQueueMethods["reorderQueuedTurns"];
  declare editQueuedTurn: CoreQueueMethods["editQueuedTurn"];
  declare deleteQueuedTurn: CoreQueueMethods["deleteQueuedTurn"];
  declare restoreQueuedTurn: CoreQueueMethods["restoreQueuedTurn"];
  declare steerQueuedTurn: CoreQueueMethods["steerQueuedTurn"];
  declare overview: CoreProjectsMethods["overview"];
  declare listDirectory: CoreProjectsMethods["listDirectory"];
  declare createProject: CoreProjectsMethods["createProject"];
  declare renameProject: CoreProjectsMethods["renameProject"];
  declare archiveProject: CoreProjectsMethods["archiveProject"];
  declare createWorkspace: CoreProjectsMethods["createWorkspace"];
  declare updateWorkspace: CoreProjectsMethods["updateWorkspace"];
  declare removeWorkspace: CoreProjectsMethods["removeWorkspace"];
  declare listThreads: CoreThreadsMethods["listThreads"];
  declare listArchivedThreads: CoreThreadsMethods["listArchivedThreads"];
  declare getThread: CoreThreadsMethods["getThread"];
  declare setThreadRead: CoreThreadsMethods["setThreadRead"];
  declare setThreadArchived: CoreThreadsMethods["setThreadArchived"];
  declare deleteThread: CoreThreadsMethods["deleteThread"];
  declare restoreThread: CoreThreadsMethods["restoreThread"];
  declare markThreadSeen: CoreThreadsMethods["markThreadSeen"];
  declare createThread: CoreThreadsMethods["createThread"];
  declare startBotThread: CoreBotThreadsMethods["startBotThread"];
  declare watchBotThread: CoreBotThreadsMethods["watchBotThread"];
  declare botThreadQueued: CoreBotThreadsMethods["botThreadQueued"];
  declare sendBotThreadMessage: CoreBotThreadsMethods["sendBotThreadMessage"];
  declare updateBotThread: CoreBotThreadsMethods["updateBotThread"];
  declare archiveBotThread: CoreBotThreadsMethods["archiveBotThread"];
  declare uploadAttachment: CoreAttachmentsMethods["uploadAttachment"];
  declare getAttachment: CoreAttachmentsMethods["getAttachment"];
  declare getThreadBlob: CoreAttachmentsMethods["getThreadBlob"];
  declare listMentionCatalog: CoreMentionsMethods["listMentionCatalog"];
  declare searchFiles: CoreMentionsMethods["searchFiles"];
  declare searchThreads: CoreMentionsMethods["searchThreads"];
  declare sendMessage: CoreMessagesMethods["sendMessage"];
  declare updateThread: CoreMessagesMethods["updateThread"];
  declare interrupt: CoreMessagesMethods["interrupt"];
  declare regenerateTitle: CoreTitlesMethods["regenerateTitle"];
  declare listModels: CoreModelsMethods["listModels"];
  declare listProviderInstances: CoreProvidersMethods["listProviderInstances"];
  declare listProxies: CoreProvidersMethods["listProxies"];
  declare saveProxy: CoreProvidersMethods["saveProxy"];
  declare deleteProxy: CoreProvidersMethods["deleteProxy"];
  declare testProxy: CoreProvidersMethods["testProxy"];
  declare moveInstanceToProxy: CoreProvidersMethods["moveInstanceToProxy"];
  declare saveProviderInstance: CoreProvidersMethods["saveProviderInstance"];
  declare deleteProviderInstance: CoreProvidersMethods["deleteProviderInstance"];
  declare setInstanceWorkers: CoreProvidersMethods["setInstanceWorkers"];
  declare setInstanceWorker: CoreProvidersMethods["setInstanceWorker"];
  declare setInstanceModels: CoreProvidersMethods["setInstanceModels"];
  declare refreshProviders: CoreProvidersMethods["refreshProviders"];
  declare installCli: CoreProvidersMethods["installCli"];
  declare checkCliUpdates: CoreProvidersMethods["checkCliUpdates"];
  declare setWorkerCliUpdateSettings: CoreProvidersMethods["setWorkerCliUpdateSettings"];
  declare startProviderLogin: CoreProvidersMethods["startProviderLogin"];
  declare syncProviderInstances: CoreProvidersMethods["syncProviderInstances"];
  declare answerInteraction: CoreInteractionsMethods["answerInteraction"];
  declare movedHistory: CoreWatchMethods["movedHistory"];
  declare createMovedThread: CoreWatchMethods["createMovedThread"];
  declare watchThread: CoreWatchMethods["watchThread"];
  declare watchOverview: CoreWatchMethods["watchOverview"];
  declare settings: CoreSettingsMethods["settings"];
  declare updateUserSettings: CoreSettingsMethods["updateUserSettings"];
  declare updateProjectSettings: CoreSettingsMethods["updateProjectSettings"];
  declare listSchedules: CoreSchedulesMethods["listSchedules"];
  declare createSchedule: CoreSchedulesMethods["createSchedule"];
  declare updateSchedule: CoreSchedulesMethods["updateSchedule"];
  declare previewSchedule: CoreSchedulesMethods["previewSchedule"];
  declare setScheduleStatus: CoreSchedulesMethods["setScheduleStatus"];
  declare setGoal: CoreGoalsMethods["setGoal"];
  declare stopBackgroundTask: CoreGoalsMethods["stopBackgroundTask"];
  declare getWorktreeSettings: CoreWorktreesMethods["getWorktreeSettings"];
  declare updateWorktreeSettings: CoreWorktreesMethods["updateWorktreeSettings"];
  declare listGitRefs: CoreWorktreesMethods["listGitRefs"];
  declare listWorktrees: CoreWorktreeLifecycleMethods["listWorktrees"];
  declare cleanupWorktrees: CoreWorktreeLifecycleMethods["cleanupWorktrees"];
  declare removeWorktree: CoreWorktreeLifecycleMethods["removeWorktree"];
  declare revealWorktree: CoreWorktreeLifecycleMethods["revealWorktree"];
  declare threadsChanged: CoreBroadcastMethods["threadsChanged"];
  declare botAction: CoreBroadcastMethods["botAction"];

  computers?: LinkedComputers;

  network?: NetworkAccess;

  readonly updates: GatewayUpdates;
  readonly departures: GatewayDepartures;
  readonly updateCenter: UpdateCenter;

  readonly mobile: MobileDevices;
  readonly desktopControl: DesktopControl;
  /** Local mode: this desktop app's own control channel (remote app updates from linked computers). */
  readonly appControl: LocalAppControl;

  readonly workers: WorkerAdministration;

  readonly workerSsh: WorkerSsh;

  /** Provider CLIs on the owner's workers: reports, latest versions, installs (docs/provider-cli.md). */
  readonly cli: CliTools;
  readonly environment: AgentEnvironment;

  readonly connectors: ConnectorsRuntime;
  readonly github: GitHubAccounts;
  #githubDetection: GitHubDetection | undefined;
  get githubDetection() {
    return (this.#githubDetection ??= new GitHubDetection(this));
  }

  readonly secrets: ThreadSecrets;

  readonly bots: BotsRuntime;

  readonly link: WorkerLink;

  readonly hub: Hub;
  /** Bot summaries and connector/proxy changes pushed to overview subscribers. */
  readonly feeds: OwnerFeeds;

  readonly bus: AgentBus;

  readonly linkedAgents: LinkedAgents;

  readonly scheduler: Scheduler;
  readonly worktreeCleanup: WorktreeCleanupSchedule;

  /** Background tasks for their agents: the tools, and the notes about every end (docs/execution.md, "Pobudka"). */
  readonly backgroundTasks: BackgroundTasks;

  /** Settings → Import: threads of the agent CLIs on the owner's workers (docs/import.md). */
  readonly imports: CliImports;

  constructor(options: GatewayCoreOptions) {
    this.role = options.role ?? "server";
    this.imports = new CliImports(this);
    this[coreState].options = options;
    this.diagnostics = new Diagnostics(this, options);
    this[coreState].actions = new ActionContext(options.runtime);
    this.hub = new Hub(
      (action) => this[coreState].actions.defer(action),
      (metric, value) => this.diagnostics.collector.measure(metric, value),
    );
    this.feeds = new OwnerFeeds(this);
    this.departures = createGatewayDepartures(this, options);
    this.linkedAgents = new LinkedAgents(this, options, {
      run: (effect) => this[coreState].actions.run(effect),
      transaction: (perform) => this[coreState].actions.transaction(perform),
    });
    this.mobile = new MobileDevices({
      runtime: options.runtime,
      userId: options.userId,
      network: () => this.network,
      publish: (update) => this.hub.publishOverview(update),
    });
    this.desktopControl = new DesktopControl(
      new DesktopUpdateStore(options.runtime, options.userId),
      this.mobile,
      (value) =>
        this.hub.publishOverview(
          create(ui.OverviewUpdateSchema, {
            change: { case: "desktopUpdate", value },
          }),
        ),
      (credential) => coreRun(this, (s) => s.authenticateWorker(credential)),
    );
    this.appControl = new LocalAppControl(options.runtime, options.userId, () => this.feeds.updatesChanged());
    this.connectors = new ConnectorsRuntime({
      runtime: options.runtime,
      userId: options.userId,
      interaction: (interaction) => corePublishInteraction(this, interaction),
    });
    this.github = createCoreGitHub(this, options);
    this.bots = createCoreBots(this, options);
    this.link = createCoreWorkerLink(this);
    this.updates = createCoreUpdates(this, options);
    this.workers = new WorkerAdministration({
      runtime: options.runtime,
      userId: options.userId,
      link: this.link,
      disconnectUpdates: (workerId) => this.updates.service.disconnect(workerId),
      network: () => this.network,
      publish: (value) =>
        this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "enrollment", value } })),
      removed: async (value) => {
        this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "workerRemoved", value } }));

        for (const project of await coreRun(this, (s) => s.listProjects(options.userId))) {
          this.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "project", value: project } }));
        }
      },
      changed: () => coreBroadcastWorkers(this),
    });
    this.cli = new CliTools({
      runtime: options.runtime,
      userId: options.userId,
      link: this.link,
      ...(options.cliLatest && { latest: options.cliLatest }),
      changed: () => coreBroadcastWorkers(this),
      log: (message) => coreLog(this, message),
    });
    this.environment = new AgentEnvironment({
      ...(options.skillSources && { sources: options.skillSources }),
      runtime: options.runtime,
      userId: options.userId,
      link: this.link,
      changed: () =>
        this.hub.publishOverview(
          create(ui.OverviewUpdateSchema, {
            change: { case: "agentEnvironmentChanged", value: true },
          }),
        ),
    });
    this.workerSsh = new WorkerSsh({
      runtime: options.runtime,
      userId: options.userId,
      workers: this.workers,
      updates: this.updates,
      ...(options.sshSecretsKey && { secretsKey: options.sshSecretsKey }),
    });
    this.secrets = new ThreadSecrets({
      runtime: options.runtime,
      link: this.link,
      hub: this.hub,
      userId: options.userId,
      ...(options.secretTtlMs !== undefined && { ttlMs: options.secretTtlMs }),
    });
    this.secrets.start();
    this.bus = createCoreBus(this);
    this.backgroundTasks = new BackgroundTasks(
      {
        run: (effect) => this[coreState].options.runtime.runPromise(effect),
        queued: async (threadId, turn) => {
          await coreBroadcastTurn(this, threadId, turn.id); // re-read: the UI gets the turn with its source
          await this.pump(threadId);
        },
        steered: (steerId) => coreSendSteer(this, steerId),
        stop: (threadId, itemId) => coreStopTask(this, threadId, itemId),
        log: (message) => coreLog(this, message),
      },
      { ...(options.backgroundGraceMs !== undefined && { graceMs: options.backgroundGraceMs }) },
    );
    // Ticks only after start() (main.ts); tests drive tick() directly.
    this.scheduler = createCoreScheduler(this, options);
    this.worktreeCleanup = new WorktreeCleanupSchedule(this);
    this.updateCenter = createUpdateCenter(this);
  }

  get online(): ReadonlySet<string> {
    return new Set([...this.link.connections.values()].flatMap((c) => (c.isOpen ? [c.workerId] : [])));
  }

  // ------------------------------------------------------------------ attachments

  get attachmentLimits(): Promise<AttachmentLimits> {
    return this.settingsStoreUser().then((user) =>
      user.attachmentLimits
        ? {
            maxFileBytes: Number(user.attachmentLimits.maxFileBytes),
            maxMessageBytes: Number(user.attachmentLimits.maxMessageBytes),
            maxFiles: user.attachmentLimits.maxFiles,
          }
        : (this[coreState].options.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS),
    );
  }

  private settingsStoreUser() {
    return this[coreState].actions.run(SettingsStore.use((s) => s.user(this[coreState].options.userId)));
  }
}

// Keep class method descriptors and the original receiver while composing the domain operations.
for (const methods of [
  coreWorkLoopMethods,
  coreQueueMethods,
  coreProjectsMethods,
  coreThreadsMethods,
  coreBotThreadsMethods,
  coreAttachmentsMethods,
  coreMentionsMethods,
  coreMessagesMethods,
  coreTitlesMethods,
  coreModelsMethods,
  coreProvidersMethods,
  coreInteractionsMethods,
  coreWatchMethods,
  coreSettingsMethods,
  coreSchedulesMethods,
  coreGoalsMethods,
  coreBroadcastMethods,
  coreWorktreesMethods,
  coreWorktreeLifecycleMethods,
]) {
  const descriptors = Object.getOwnPropertyDescriptors(methods);

  for (const descriptor of Object.values(descriptors)) descriptor.enumerable = false;
  Object.defineProperties(GatewayCore.prototype, descriptors);
}
