import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, type ServiceImpl } from "@connectrpc/connect";
import { ui, bots, connectors } from "@canopy/contracts";
import { ConnectorFailure } from "../connectors/store.ts";
import { InvalidError, UnavailableError, type GatewayCore } from "../core/core.ts";
import { Invalid, InstanceConflict, NotFound, QueueConflict, ScheduleConflict, SettingsConflict } from "../store/index.ts";
import { workerGuard } from "../core/worker-administration.ts";
import { mobileGuard, mobileIdentity } from "../core/mobile-devices.ts";
import { workerInstall } from "../updates/install.ts";
import { computerGuard } from "../computers/runtime.ts";
import { routed } from "./routed.ts";

function computers(core: GatewayCore) {
  if (!core.computers) throw new ConnectError("Linked computers are not initialized", Code.FailedPrecondition);
  return core.computers;
}

function shared(core: GatewayCore) {
  const config = computers(core).shared;
  if (!config) throw new ConnectError("Shared configuration is not available on this computer", Code.FailedPrecondition);
  return config;
}

export type UiHandlers = ServiceImpl<typeof ui.GatewayService>;

/** GatewayService for the UI (docs/ui-api.md), with threads of linked computers routed to their home (routed.ts). */
export function uiRoutes(core: GatewayCore): (router: ConnectRouter) => void {
  return (router) => router.service(ui.GatewayService, routed(core, uiHandlers(core)));
}

/** This computer's own GatewayService. Thin: validation and state live in the core and the store. */
export function uiHandlers(core: GatewayCore): UiHandlers {
  return {
    getComputers: () => computerGuard(() => computers(core).snapshot()),
    createComputerPairing: () => computerGuard(() => computers(core).createPairing()),
    linkComputer: (r) => computerGuard(() => computers(core).pair(r.address, r.code)),
    manageComputer: (r) => computerGuard(() => computers(core).manage(r)),
    getSharedConfig: () => computerGuard(() => shared(core).snapshot()),
    manageSharedConfig: (r) => computerGuard(() => shared(core).manage(r)),
    fetchWorkerInstall: (request, context) => workerInstall(core.updates, request, context.signal),
    workerSsh: (request, context) => core.workerSsh.run(request, context.signal),
    getUpdates: () => core.updates.snapshot(),
    manageUpdates: (request) => core.updates.manage(request),
    getMobileDevices: () => mobileGuard(() => core.mobile.list()),
    createMobilePairing: () => mobileGuard(() => core.mobile.create()),
    revokeMobilePairing: (r) => mobileGuard(async () => { await core.mobile.revoke(r.id, "pairing"); return create(ui.MobileOperationResponseSchema); }),
    revokeMobileDevice: (r) => mobileGuard(async () => { await core.mobile.revoke(r.id, "device"); return create(ui.MobileOperationResponseSchema); }),
    unpairMobileDevice: (_r, context) => mobileGuard(async () => {
      const identity = context.values.get(mobileIdentity);
      if (!identity) throw new ConnectError("Device token required", Code.Unauthenticated);
      await core.mobile.revoke(identity.deviceId, "device");
      return create(ui.MobileOperationResponseSchema);
    }),
    getWorkerSetup: () => workerGuard(async () => {
      const setup = await core.workers.setup();
      const updates = await core.updates.snapshot();
      setup.gatewayVersion = updates.gatewayVersion; setup.channel = updates.channel;
      return setup;
    }),
    createWorkerEnrollment: (r) => workerGuard(() => core.workers.create(r.name)),
    revokeWorkerEnrollment: (r) => workerGuard(async () => { await core.workers.revokeEnrollment(r.id); return create(ui.WorkerOperationResponseSchema); }),
    renameWorker: (r) => workerGuard(async () => { await core.workers.manage(r.workerId, "rename", r.name); return create(ui.WorkerOperationResponseSchema); }),
    rotateWorkerCredential: (r) => workerGuard(async () => create(ui.RotateWorkerCredentialResponseSchema, { credential: await core.workers.manage(r.workerId, "rotate") })),
    revokeWorker: (r) => workerGuard(async () => { await core.workers.manage(r.workerId, "revoke"); return create(ui.WorkerOperationResponseSchema); }),
    archiveWorker: (r) => workerGuard(async () => { await core.workers.manage(r.workerId, "archive"); return create(ui.WorkerOperationResponseSchema); }),
    listConnectors: (r) => connectorGuard(() => core.connectors.list(r)),
    saveConnectorAccount: (r) => connectorGuard(async () => create(connectors.ConnectorAccountResponseSchema, { account: await core.connectors.save(r) })),
    setConnectorAccess: (r) => connectorGuard(async () => create(connectors.ConnectorAccountResponseSchema, { account: await core.connectors.access(r) })),
    deleteConnectorAccount: (r) => connectorGuard(async () => { await core.connectors.remove(r.accountId); return create(connectors.DeleteConnectorAccountResponseSchema, {}); }),
    disconnectConnector: (r) => connectorGuard(async () => create(connectors.ConnectorAccountResponseSchema, { account: await core.connectors.disconnect(r.accountId) })),
    testConnector: (r) => connectorGuard(async () => create(connectors.TestConnectorResponseSchema, await core.connectors.test(r.accountId))),
    saveConnectorOAuthApp: (r) => connectorGuard(async () => { await core.connectors.saveApp(r); return create(connectors.SaveConnectorOAuthAppResponseSchema); }),
    beginConnectorOAuth: (r) => connectorGuard(() => core.connectors.begin(r)),
    completeConnectorOAuth: async (r) => {
      try { return create(connectors.CompleteConnectorOAuthResponseSchema, { account: await core.connectors.complete(r) }); }
      catch { return create(connectors.CompleteConnectorOAuthResponseSchema, { error: 'Authorization expired, was declined or could not finish. Reconnect the account.' }); }
    },
    createBot: (r) => guard(async () => create(bots.GetBotResponseSchema, { bot: await core.bots.create(r) })),
    updateBot: (r) => guard(async () => create(bots.GetBotResponseSchema, { bot: await core.bots.update(r) })),
    deleteBot: (r) => guard(async () => { await core.bots.remove(r.botId); return create(bots.DeleteBotResponseSchema); }),
    listBots: (r) => guard(async () => create(bots.ListBotsResponseSchema, { bots: await core.bots.list(r.includeArchived) })),
    archiveBot: (r) => guard(async () => create(bots.GetBotResponseSchema, { bot: await core.bots.archive(r.botId, true) })),
    unarchiveBot: (r) => guard(async () => create(bots.GetBotResponseSchema, { bot: await core.bots.archive(r.botId, false) })),
    getBot: (r) => guard(async () => create(bots.GetBotResponseSchema, { bot: await core.bots.get(r.botId) })),
    sendBotMessage: (r) => guard(async () => create(bots.SendBotMessageResponseSchema, { turnId: await core.bots.send(r) })),
    watchBotConversation: (r, context) => core.bots.watch(r.botId, context.signal),
    readBotExchange: (r) => guard(async () => create(bots.ReadBotExchangeResponseSchema, { messages: await core.bots.exchange(r.exchangeId) })),
    answerBotApproval: (r) => guard(async () => create(bots.AnswerBotApprovalResponseSchema, { approval: await core.bots.answer(r) })),
    interruptBot: (r) => guard(async () => { await core.bots.interrupt(r.botId); return create(bots.InterruptBotResponseSchema); }),
    retryBot: (r) => guard(async () => { await core.bots.retry(r.botId); return create(bots.RetryBotResponseSchema); }),
    setBotRoutineEnabled: (r) => guard(async () => create(bots.BotRoutineResponseSchema, { routine: await core.bots.setRoutineEnabled(r) })),
    deleteBotRoutine: (r) => guard(async () => { await core.bots.deleteRoutine(r); return create(bots.DeleteBotRoutineResponseSchema); }),
    cancelBotReminder: (r) => guard(async () => { await core.bots.cancelReminder(r); return create(bots.CancelBotReminderResponseSchema); }),
    markBotRead: (r) => guard(async () => create(bots.GetBotResponseSchema, { bot: await core.bots.markRead(r) })),
    saveBotMcpServer: (r) => connectorGuard(async () => create(bots.SaveBotMcpServerResponseSchema, { server: await core.bots.saveServer(r) })),
    listBotMcpServers: () => connectorGuard(async () => create(bots.ListBotMcpServersResponseSchema, { servers: await core.bots.servers() })),
    deleteBotMcpServer: (r) => connectorGuard(async () => { await core.bots.deleteServer(r.serverId); return create(bots.DeleteBotMcpServerResponseSchema); }),
    testBotMcpServer: (r) => connectorGuard(async () => create(bots.TestBotMcpServerResponseSchema, { tools: await core.bots.testServer(r.serverId) })),
    getOverview: () => guard(() => core.overview()),
    watchOverview: (request, context) => core.watchOverview(context.signal, request.includeSnapshot),
    listDirectory: (request) => guard(() => core.listDirectory(request.workerId, request.path)),
    createProject: (request) => guard(async () => create(ui.CreateProjectResponseSchema, { project: await core.createProject(request.name) })),
    renameProject: (request) => guard(async () => create(ui.CreateProjectResponseSchema, { project: await core.renameProject(request.projectId, request.name) })),
    archiveProject: (request) => guard(async () => { await core.archiveProject(request.projectId); return create(ui.ArchiveProjectResponseSchema); }),
    createWorkspace: (request) =>
      guard(async () => create(ui.CreateWorkspaceResponseSchema, { workspace: await core.createWorkspace(request) })),
    updateWorkspace: (request) =>
      guard(async () => create(ui.UpdateWorkspaceResponseSchema, { workspace: await core.updateWorkspace(request) })),
    removeWorkspace: (request) =>
      guard(async () => {
        await core.removeWorkspace(request.workspaceId);
        return create(ui.RemoveWorkspaceResponseSchema, {});
      }),
    listThreads: (request) => guard(async () => create(ui.ListThreadsResponseSchema, { threads: await core.listThreads(request.projectId, request.includeArchived, request.sidebarOnly) })),
    listArchivedThreads: (request) => guard(() => core.listArchivedThreads(request)),
    getThread: (request) => guard(async () => create(ui.GetThreadResponseSchema, { thread: await core.getThread(request.threadId) })),
    createThread: (request) => guard(async () => create(ui.CreateThreadResponseSchema, { thread: await core.createThread(request) })),
    sendMessage: (request) => guard(async () => create(ui.SendMessageResponseSchema, await core.sendMessage(request))),
    interruptThread: (request) =>
      guard(async () => {
        await core.interrupt(request.threadId);
        return create(ui.InterruptThreadResponseSchema, {});
      }),
    answerInteraction: (request) =>
      guard(async () => create(ui.AnswerInteractionResponseSchema, { interaction: await core.answerInteraction(request) })),
    // Never log, echo or attach the request/cause to errors from the secret boundary.
    answerThreadSecret: async (request) => {
      try { return create(ui.ThreadSecretResponseSchema, { secret: await core.secrets.answer(request) }); }
      catch { throw new ConnectError("Could not save the secret. Try again.", Code.InvalidArgument); }
    },
    revokeThreadSecret: (request) => guard(async () => create(ui.ThreadSecretResponseSchema, { secret: await core.secrets.revoke(request.requestId) })),
    watchThread: (request, context) => core.watchThread(request.threadId, context.signal),
    listSchedules: (request) => guard(async () => create(ui.ListSchedulesResponseSchema, { schedules: await core.listSchedules(request) })),
    createSchedule: (request) => guard(async () => create(ui.CreateScheduleResponseSchema, { schedule: await core.createSchedule(request) })),
    updateSchedule: (request) => guard(async () => create(ui.UpdateScheduleResponseSchema, { schedule: await core.updateSchedule(request) })),
    getSettings: () => guard(() => core.settings()),
    updateUserSettings: (request) =>
      guard(async () => create(ui.UpdateUserSettingsResponseSchema, { settings: await core.updateUserSettings(request) })),
    updateProjectSettings: (request) =>
      guard(async () => create(ui.UpdateProjectSettingsResponseSchema, { settings: await core.updateProjectSettings(request) })),
    previewSchedule: (request) => guard(async () => core.previewSchedule(request)),
    setScheduleStatus: (request) =>
      guard(async () => create(ui.SetScheduleStatusResponseSchema, { schedule: await core.setScheduleStatus(request) })),
    listModels: (request) => guard(async () => create(ui.ListModelsResponseSchema, { workers: await core.listModels(request) })),
    updateThread: (request) => guard(async () => create(ui.UpdateThreadResponseSchema, { thread: await core.updateThread(request) })),
    regenerateTitle: (request) => guard(async () => {
      await core.regenerateTitle(request.threadId);
      return create(ui.RegenerateTitleResponseSchema);
    }),
    setGoal: (request) => guard(async () => create(ui.SetGoalResponseSchema, { goal: await core.setGoal(request) })),
    stopBackgroundTask: (request) =>
      guard(async () => {
        await core.stopBackgroundTask(request);
        return create(ui.StopBackgroundTaskResponseSchema, {});
      }),
    listProviderInstances: () => guard(async () => create(ui.ListProviderInstancesResponseSchema, { instances: await core.listProviderInstances() })),
    saveProviderInstance: (request) => guard(async () => create(ui.SaveProviderInstanceResponseSchema, { instance: await core.saveProviderInstance(request) })),
    deleteProviderInstance: (request) =>
      guard(async () => {
        await core.deleteProviderInstance(request);
        return create(ui.DeleteProviderInstanceResponseSchema, {});
      }),
    setInstanceWorkers: (request) => guard(async () => create(ui.SetInstanceWorkersResponseSchema, { instance: await core.setInstanceWorkers(request) })),
    setInstanceWorker: (request) => guard(async () => create(ui.SetInstanceWorkerResponseSchema, { instance: await core.setInstanceWorker(request) })),
    setInstanceModels: (request) => guard(async () => create(ui.SetInstanceModelsResponseSchema, { instance: await core.setInstanceModels(request) })),
    refreshProviders: (request) => guard(() => core.refreshProviders(request)),
    startProviderLogin: (request) => guard(() => core.startProviderLogin(request)),
    installCli: (request) => guard(() => core.installCli(request)),
    checkCliUpdates: (request) => guard(() => core.checkCliUpdates(request)),
    uploadAttachment: (request) =>
      guard(async () => create(ui.UploadAttachmentResponseSchema, { attachment: await core.uploadAttachment(request.name, request.data) })),
    getAttachment: (request) => guard(() => core.getAttachment(request.attachmentId, request.thumbnail)),
    getThreadBlob: (request) => guard(() => core.getThreadBlob(request.threadId, request.sha256)),
    reorderQueuedTurns: (request) =>
      guard(async () => create(ui.ReorderQueuedTurnsResponseSchema, { turns: await core.reorderQueuedTurns(request) })),
    editQueuedTurn: (request) => guard(async () => create(ui.EditQueuedTurnResponseSchema, { turn: await core.editQueuedTurn(request) })),
    deleteQueuedTurn: (request) => guard(async () => create(ui.DeleteQueuedTurnResponseSchema, { turn: await core.deleteQueuedTurn(request.turnId) })),
    restoreQueuedTurn: (request) => guard(async () => create(ui.RestoreQueuedTurnResponseSchema, { turn: await core.restoreQueuedTurn(request.turnId) })),
    steerQueuedTurn: (request) => guard(async () => create(ui.SteerQueuedTurnResponseSchema, await core.steerQueuedTurn(request.turnId))),
    listMentionCatalog: (request) => guard(() => core.listMentionCatalog(request)),
    searchFiles: (request) => guard(() => core.searchFiles(request)),
    searchThreads: (request) => guard(() => core.searchThreads(request)),
    markThreadSeen: (request) =>
      guard(async () => create(ui.MarkThreadSeenResponseSchema, { thread: await core.markThreadSeen(request.threadId, request.upToSeq) })),
    setThreadRead: (request) => guard(async () => create(ui.MarkThreadSeenResponseSchema, { thread: await core.setThreadRead(request.threadId, request.unread) })),
    setThreadArchived: (request) => guard(async () => create(ui.GetThreadResponseSchema, { thread: await core.setThreadArchived(request.threadId, request.archived) })),
    deleteThread: (request) => guard(async () => create(ui.DeleteThreadResponseSchema, { threadIds: await core.deleteThread(request.threadId) })),
    restoreThread: (request) => guard(async () => create(ui.ListThreadsResponseSchema, { threads: await core.restoreThread(request.threadId) })),
  };
}

async function guard<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (error) {
    throw toConnectError(error);
  }
}

/** Credential boundaries never log raw causes, including SQL bound parameters. */
async function connectorGuard<A>(run: () => Promise<A>): Promise<A> {
  try { return await run(); }
  catch (error) {
    let current = error;
    for (let i = 0; i < 6 && current && typeof current === "object"; i++, current = (current as { cause?: unknown }).cause) {
      if (current instanceof ConnectorFailure) throw new ConnectError(current.message, Code.InvalidArgument);
    }
    throw new ConnectError("Connector operation failed. Check the configuration and try again.", Code.InvalidArgument);
  }
}

/** Domain errors keep their meaning; anything else is internal and not echoed with details. */
export function toConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  const cause = unwrap(error);
  if (cause instanceof NotFound) return new ConnectError(cause.message, Code.NotFound);
  if (cause instanceof Invalid || cause instanceof InvalidError) return new ConnectError(cause.message, Code.InvalidArgument);
  if (cause instanceof UnavailableError) return new ConnectError(cause.message, Code.Unavailable);
  if (cause instanceof SettingsConflict || cause instanceof InstanceConflict || cause instanceof QueueConflict || cause instanceof ScheduleConflict) return new ConnectError(cause.message, Code.FailedPrecondition);
  const constraint = constraintOf(cause);
  if (constraint) return new ConnectError(`rejected by ${constraint}`, Code.FailedPrecondition);
  console.error(error);
  return new ConnectError("internal error", Code.Internal);
}

/** Effect failures surface as FiberFailure-like wrappers; find the original error. */
function unwrap(error: unknown): unknown {
  let current = error;
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    if (
      current instanceof NotFound ||
      current instanceof Invalid ||
      current instanceof InvalidError ||
      current instanceof UnavailableError ||
      current instanceof SettingsConflict ||
      current instanceof ScheduleConflict ||
      current instanceof QueueConflict
    ) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return error;
}

function constraintOf(error: unknown): string | undefined {
  for (let current = error, i = 0; i < 6 && current && typeof current === "object"; i++, current = (current as { cause?: unknown }).cause) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === "string") return constraint;
  }
  return undefined;
}
