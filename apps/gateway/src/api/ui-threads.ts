import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { type GatewayCore } from "../core/core.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

export function threadsHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "listThreads"
  | "listArchivedThreads"
  | "getThread"
  | "createThread"
  | "sendMessage"
  | "interruptThread"
  | "answerInteraction"
  | "answerThreadSecret"
  | "revokeThreadSecret"
  | "watchThread"
  | "updateThread"
  | "regenerateTitle"
  | "setGoal"
  | "stopBackgroundTask"
  | "markThreadSeen"
  | "setThreadRead"
  | "setThreadArchived"
  | "deleteThread"
  | "restoreThread"
> {
  return {
    listThreads: (request) =>
      guard(async () =>
        create(ui.ListThreadsResponseSchema, {
          threads: await core.listThreads(request.projectId, request.includeArchived, request.sidebarOnly),
        }),
      ),

    listArchivedThreads: (request) => guard(() => core.listArchivedThreads(request)),

    getThread: (request) =>
      guard(async () => create(ui.GetThreadResponseSchema, { thread: await core.getThread(request.threadId) })),

    createThread: (request) =>
      guard(async () => create(ui.CreateThreadResponseSchema, { thread: await core.createThread(request) })),

    sendMessage: (request) => guard(async () => create(ui.SendMessageResponseSchema, await core.sendMessage(request))),

    interruptThread: (request) =>
      guard(async () => {
        await core.interrupt(request.threadId);

        return create(ui.InterruptThreadResponseSchema, {});
      }),

    answerInteraction: (request) =>
      guard(async () =>
        create(ui.AnswerInteractionResponseSchema, { interaction: await core.answerInteraction(request) }),
      ),

    // Never log, echo or attach the request/cause to errors from the secret boundary.
    answerThreadSecret: async (request) => {
      try {
        return create(ui.ThreadSecretResponseSchema, { secret: await core.secrets.answer(request) });
      } catch {
        throw new ConnectError("Could not save the secret. Try again.", Code.InvalidArgument);
      }
    },

    revokeThreadSecret: (request) =>
      guard(async () =>
        create(ui.ThreadSecretResponseSchema, { secret: await core.secrets.revoke(request.requestId) }),
      ),

    watchThread: (request, context) => core.watchThread(request.threadId, context.signal),

    updateThread: (request) =>
      guard(async () => create(ui.UpdateThreadResponseSchema, { thread: await core.updateThread(request) })),

    regenerateTitle: (request) =>
      guard(async () => {
        await core.regenerateTitle(request.threadId);

        return create(ui.RegenerateTitleResponseSchema);
      }),

    setGoal: (request) => guard(async () => create(ui.SetGoalResponseSchema, { goal: await core.setGoal(request) })),

    stopBackgroundTask: (request) =>
      guard(async () => {
        await core.stopBackgroundTask(request);

        return create(ui.StopBackgroundTaskResponseSchema, {});
      }),

    markThreadSeen: (request) =>
      guard(async () =>
        create(ui.MarkThreadSeenResponseSchema, {
          thread: await core.markThreadSeen(request.threadId, request.upToSeq),
        }),
      ),

    setThreadRead: (request) =>
      guard(async () =>
        create(ui.MarkThreadSeenResponseSchema, { thread: await core.setThreadRead(request.threadId, request.unread) }),
      ),

    setThreadArchived: (request) =>
      guard(async () =>
        create(ui.GetThreadResponseSchema, {
          thread: await core.setThreadArchived(request.threadId, request.archived),
        }),
      ),

    deleteThread: (request) =>
      guard(async () =>
        create(ui.DeleteThreadResponseSchema, { threadIds: await core.deleteThread(request.threadId) }),
      ),

    restoreThread: (request) =>
      guard(async () => create(ui.ListThreadsResponseSchema, { threads: await core.restoreThread(request.threadId) })),
  };
}
