import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { ui } from "@open-agents/contracts";
import { InvalidError, UnavailableError, type GatewayCore } from "../core/core.ts";
import { Invalid, NotFound, ProfileConflict, QueueConflict, SettingsConflict } from "../store/index.ts";

/** GatewayService for the UI (docs/ui-api.md). Thin: validation and state live in the core and the store. */
export function uiRoutes(core: GatewayCore): (router: ConnectRouter) => void {
  return (router) =>
    router.service(ui.GatewayService, {
      getOverview: () => guard(() => core.overview()),
      watchOverview: (_request, context) => core.watchOverview(context.signal),
      listDirectory: (request) => guard(() => core.listDirectory(request.workerId, request.path)),
      createProject: (request) => guard(async () => create(ui.CreateProjectResponseSchema, { project: await core.createProject(request.name) })),
      createWorkspace: (request) =>
        guard(async () => create(ui.CreateWorkspaceResponseSchema, { workspace: await core.createWorkspace(request) })),
      updateWorkspace: (request) =>
        guard(async () => create(ui.UpdateWorkspaceResponseSchema, { workspace: await core.updateWorkspace(request) })),
      removeWorkspace: (request) =>
        guard(async () => {
          await core.removeWorkspace(request.workspaceId);
          return create(ui.RemoveWorkspaceResponseSchema, {});
        }),
      listThreads: (request) => guard(async () => create(ui.ListThreadsResponseSchema, { threads: await core.listThreads(request.projectId) })),
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
      watchThread: (request, context) => core.watchThread(request.threadId, context.signal),
      listSchedules: (request) => guard(async () => create(ui.ListSchedulesResponseSchema, { schedules: await core.listSchedules(request) })),
      createSchedule: (request) => guard(async () => create(ui.CreateScheduleResponseSchema, { schedule: await core.createSchedule(request) })),
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
      setGoal: (request) => guard(async () => create(ui.SetGoalResponseSchema, { goal: await core.setGoal(request) })),
      stopBackgroundTask: (request) =>
        guard(async () => {
          await core.stopBackgroundTask(request);
          return create(ui.StopBackgroundTaskResponseSchema, {});
        }),
      listProviderProfiles: (request) => guard(() => core.listProviderProfiles(request.workerId)),
      saveProviderProfile: (request) => guard(() => core.saveProviderProfile(request)),
      deleteProviderProfile: (request) =>
        guard(async () => create(ui.DeleteProviderProfileResponseSchema, { configVersion: await core.deleteProviderProfile(request) })),
      setModelSelection: (request) =>
        guard(async () => {
          const selection = await core.setModelSelection(request);
          return create(ui.SetModelSelectionResponseSchema, selection ? { selection } : {});
        }),
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
    });
}

async function guard<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (error) {
    throw toConnectError(error);
  }
}

/** Domain errors keep their meaning; anything else is internal and not echoed with details. */
export function toConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  const cause = unwrap(error);
  if (cause instanceof NotFound) return new ConnectError(cause.message, Code.NotFound);
  if (cause instanceof Invalid || cause instanceof InvalidError) return new ConnectError(cause.message, Code.InvalidArgument);
  if (cause instanceof UnavailableError) return new ConnectError(cause.message, Code.Unavailable);
  if (cause instanceof SettingsConflict || cause instanceof ProfileConflict || cause instanceof QueueConflict) return new ConnectError(cause.message, Code.FailedPrecondition);
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
