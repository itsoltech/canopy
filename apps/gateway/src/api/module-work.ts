import { isMessage, type Message } from "@bufbuild/protobuf";
import { bots, ui } from "@canopy/contracts";
import type { ModuleId } from "@canopy/domain";
import { Code, ConnectError } from "@connectrpc/connect";
import { coreState } from "../core/core-context.ts";
import type { GatewayCore } from "../core/core.ts";
import { moduleDisabledMessage, ownerModuleEnabled } from "../store/module-access.ts";
import { PLAIN, stream, unary, type Handler } from "./routed-context.ts";
import type { UiHandlers } from "./ui-service.ts";

/** RPCs that start work, including operations exposed by stale clients. Settings,
 * history, cancellation, cleanup, and worker administration remain reachable. */
const threadWork = new Set<string>([
  "createThread",
  "createThreadWithProgress",
  "continueThreadInWorktree",
  "previewThreadTransfer",
  "startThreadTransfer",
  "sendMessage",
  "regenerateTitle",
  "rewindThread",
  "restoreThreadRewind",
  "prepareThreadRewind",
  "restoreQueuedTurn",
  "steerQueuedTurn",
  "answerInteraction",
  "answerThreadSecret",
  "updateTurnPermissions",
  "createSchedule",
  "updateSchedule",
  "setScheduleStatus",
  "setGoal",
  "investigateDiagnostics",
  "continueImportedThread",
  "startImport",
  "scanImport",
  "resumeImportRun",
  "addProject",
  "cloneProject",
  "copyWorkspace",
  "getWorkspaceCopyManifest",
  "workspaceCopySource",
  "workspaceCopyTarget",
  "startWorkspaceCopy",
  "retryWorkspaceCopyJob",
  "switchWorkspaceBranch",
  "cleanUpFailedWorktree",
  "watchAgentPreview",
  "sendAgentPreviewInput",
  "runAgentTool",
  "pullThreadOrigin",
  "switchThreadBranch",
  "listThreadBranches",
  "getThreadGitStatus",
  "revealThreadDirectory",
  "readThreadFile",
  "listThreadDirectory",
  "listThreadDiff",
  "readThreadDiff",
  "getThreadFileHighlight",
  "watchThreadFiles",
  "revealThreadFile",
  "searchFiles",
  "searchIssues",
  "listMentionCatalog",
  "writeThreadFile",
  "deleteThreadFile",
  "openThreadFile",
  "watchPullRequest",
  "linkThreadPullRequest",
  "preparePullRequestContext",
  "preparePullRequestMutation",
  "createPullRequestComment",
  "replyPullRequestReviewThread",
  "updatePullRequestComment",
  "deletePullRequestComment",
  "setPullRequestFileViewed",
  "addPullRequestReviewComment",
  "submitPullRequestReview",
  "setPullRequestReviewThreadResolved",
  "preparePullRequestDraftContext",
  "createPullRequest",
  "setPullRequestDraft",
  "mergePullRequest",
  "setPullRequestQueue",
  "setPullRequestAutoMerge",
  "updatePullRequestBranch",
  "setPullRequestOpen",
  "updatePullRequestDetails",
  "requestPullRequestReviewers",
  "setPullRequestAssignees",
  "setPullRequestLabels",
  "rerunPullRequestChecks",
] satisfies (keyof UiHandlers)[]);

const botWork = new Set<string>([
  "createBot",
  "sendBotMessage",
  "setBotMessageReaction",
  "retryBot",
  "answerBotApproval",
  "setBotRoutineEnabled",
  "setBotTriggerEnabled",
] satisfies (keyof UiHandlers)[]);

function workModule(method: string): ModuleId | undefined {
  if (threadWork.has(method)) return "threads";

  return botWork.has(method) ? "bots" : undefined;
}

export function moduleStreamSignal(core: GatewayCore, method: string, signal: AbortSignal) {
  const module = workModule(method);

  return module ? AbortSignal.any([signal, core[coreState].moduleStreams[module].signal]) : signal;
}

export async function requireModuleWork(core: GatewayCore, method: string, request: Message) {
  const module = workModule(method);

  if (!module) return;

  // Attaching an existing directory to a project is available through Settings.
  if (method === "addProject" && isMessage(request, ui.AddProjectRequestSchema) && request.source.case !== "clone")
    return;

  if (isMessage(request, ui.SetScheduleStatusRequestSchema) && request.status !== "active") return;

  if (isMessage(request, ui.SetGoalRequestSchema) && ["clear", "pause"].includes(request.action)) return;

  if (isMessage(request, bots.SetBotRoutineEnabledRequestSchema) && !request.enabled) return;

  if (isMessage(request, bots.SetBotTriggerEnabledRequestSchema) && !request.enabled) return;

  if (isMessage(request, ui.WorkspaceCopySourceRequestSchema) && request.release) return;

  if (isMessage(request, ui.WorkspaceCopyTargetRequestSchema) && request.operation?.action.case === "cancel") return;

  // Settings → Agent tools operates on a separate worker session.
  if (isMessage(request, ui.RunAgentToolRequestSchema) && !PLAIN.test(request.operation?.session ?? "")) return;

  const { runtime, userId } = core[coreState].options;

  if (!(await runtime.runPromise(ownerModuleEnabled(userId, module))))
    throw new ConnectError(moduleDisabledMessage(module), Code.FailedPrecondition);
}

/** Guard at the originating gateway before draft receipts or routing to a peer.
 * remoteServe repeats the check at the destination using its current settings. */
export function guardModuleWork(core: GatewayCore, handlers: UiHandlers): UiHandlers {
  // SAFETY: The wrapper calls the same handler with the message decoded for that method.
  const own = handlers as Record<string, Handler>;

  for (const method of ui.GatewayService.methods) {
    const module = workModule(method.localName);

    if (!module) continue;
    const handle = own[method.localName]!;

    own[method.localName] =
      method.methodKind === "unary"
        ? async (request, context) => {
            await requireModuleWork(core, method.localName, request);

            return unary(handle, request, context);
          }
        : async function* (request, context) {
            const signal = moduleStreamSignal(core, method.localName, context.signal);
            await requireModuleWork(core, method.localName, request);
            signal.throwIfAborted();
            yield* stream(handle, request, { ...context, signal });
          };
  }

  return handlers;
}
