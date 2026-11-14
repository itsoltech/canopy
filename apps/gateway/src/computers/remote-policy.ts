import { isMessage, type DescMessage, type Message, type MessageShape } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { bots, github, computerLink as link, ui } from "@canopy/contracts";
import { REMOTE_BOTS, REMOTE_BOT_COMPOSER, REMOTE_THREAD_PANEL } from "@canopy/domain/computers";
import {
  GITHUB_ACCOUNTS,
  GITHUB_PR,
  GITHUB_COMMENTS,
  GITHUB_REVIEW,
  GITHUB_LIFECYCLE,
  GITHUB_METADATA,
  GITHUB_WRITE,
} from "@canopy/domain/computers";

export const GITHUB_METADATA_METHODS = new Set([
  "GetPullRequestMetadata",
  "UpdatePullRequestDetails",
  "RequestPullRequestReviewers",
  "SetPullRequestAssignees",
  "SetPullRequestLabels",
]);

/** Draft source never crosses an onward-sharing relay, including a malicious relay envelope. */
export const fileHighlightDraft = (method: { name: string }, request: Message): boolean =>
  method.name === "GetThreadFileHighlight" &&
  linkedMessage(ui.ThreadFileHighlightRequestSchema, request).draft !== undefined;

export const GITHUB_LIFECYCLE_METHODS = new Set([
  "GetPullRequestCreateContext",
  "PreparePullRequestDraftContext",
  "CreatePullRequest",
  "SetPullRequestDraft",
  "MergePullRequest",
  "SetPullRequestQueue",
  "SetPullRequestAutoMerge",
  "UpdatePullRequestBranch",
  "SetPullRequestOpen",
]);

export const GITHUB_REVIEW_METHODS = new Set([
  "GetPullRequestReviewDraft",
  "AddPullRequestReviewComment",
  "SubmitPullRequestReview",
  "DiscardPullRequestReview",
  "SetPullRequestReviewThreadResolved",
]);

export const GITHUB_MUTATION_METHODS = new Set([
  "PreparePullRequestMutation",
  "GetPullRequestMutation",
  "CreatePullRequestComment",
  "ReplyPullRequestReviewThread",
  "UpdatePullRequestComment",
  "DeletePullRequestComment",
  "SetPullRequestFileViewed",
]);

export const GITHUB_PR_METHODS = new Set([
  "GetGitHubRepositoryAccount",
  "SetGitHubRepositoryAccount",
  "ListThreadPullRequests",
  "ListRepositoryPullRequests",
  "LinkThreadPullRequest",
  "UnlinkThreadPullRequest",
  "GetPullRequest",
  "GetPullRequestAvatar",
  "GetPullRequestImage",
  "RefreshPullRequest",
  "WatchPullRequest",
  "ListPullRequestTimeline",
  "ListPullRequestReviewThreads",
  "ListPullRequestChecks",
  "ListPullRequestCheckJobs",
  "GetPullRequestJobLog",
  "ListPullRequestCommits",
  "ListPullRequestFiles",
  "GetPullRequestDiff",
  "PreparePullRequestContext",
]);

export const GITHUB_METHODS = new Set([
  "ListGitHubAccounts",
  "GetGitHubUpdateAccount",
  "SetGitHubUpdateAccount",
  "BeginGitHubDeviceAuth",
  "GetGitHubDeviceAuth",
  "CancelGitHubDeviceAuth",
  "DisconnectGitHubAccount",
  "UseGitHubPat",
  "ListGitHubInstallations",
  "ListGitHubRepositories",
]);

export function botFeature(method: { name: string }, request: Message): string | undefined {
  if (["GetThreadPanel", "SetThreadConnectorGrant"].includes(method.name)) return REMOTE_THREAD_PANEL;

  if (["RerunPullRequestChecks", "CancelPullRequestCheckRun"].includes(method.name)) return GITHUB_WRITE;

  if (
    method.name === "PreparePullRequestMutation" &&
    ["rerun_checks", "cancel_run"].includes(linkedMessage(github.PullRequestMutationRequestSchema, request).action)
  )
    return GITHUB_WRITE;

  if (GITHUB_METADATA_METHODS.has(method.name)) return GITHUB_METADATA;

  if (GITHUB_LIFECYCLE_METHODS.has(method.name)) return GITHUB_LIFECYCLE;

  if (GITHUB_REVIEW_METHODS.has(method.name)) return GITHUB_REVIEW;

  if (GITHUB_MUTATION_METHODS.has(method.name)) return GITHUB_COMMENTS;

  if (GITHUB_METHODS.has(method.name)) return GITHUB_ACCOUNTS;

  if (GITHUB_PR_METHODS.has(method.name)) return GITHUB_PR;
  const send = method.name === "SendBotMessage" ? linkedMessage(bots.SendBotMessageRequestSchema, request) : undefined;

  if (
    method.name === "GetBotDraft" ||
    method.name === "SaveBotDraft" ||
    (send && (send.attachmentIds.length > 0 || send.draftRevision !== undefined)) ||
    (method.name === "UploadAttachment" && linkedMessage(ui.UploadAttachmentRequestSchema, request).botId)
  )
    return REMOTE_BOT_COMPOSER;

  return BOT_METHODS.has(method.name) ? REMOTE_BOTS : undefined;
}

/** Explicit home operations, plus capability-gated internal services.
 * GitHub account DTOs contain no credentials; generic credential and connector administration stays local. */
export const SERVED = new Set([
  "RerunPullRequestChecks",
  "CancelPullRequestCheckRun",
  ...GITHUB_METADATA_METHODS,
  ...GITHUB_LIFECYCLE_METHODS,
  ...GITHUB_METHODS,
  ...GITHUB_PR_METHODS,
  ...GITHUB_MUTATION_METHODS,
  ...GITHUB_REVIEW_METHODS,
  "ReadDiagnosticsSnapshot",
  "CollectHomeDiagnosticsLogs",
  "ResetDiagnosticsCounters",
  "ControlHomeDiagnosticsTrace",
  "ExportHomeDiagnosticsTrace",
  "GetOverview",
  "WatchOverview",
  "ListThreads",
  "GetThread",
  "GetComposerDraftDelivery",
  "GetThreadPanel",
  "SetThreadConnectorGrant",
  "WatchThread",
  "CreateThread",
  "SendMessage",
  "PrepareThreadRewind",
  "RewindThread",
  "RestoreThreadRewind",
  "GetThreadRewind",
  "InterruptThread",
  "AnswerInteraction",
  "AnswerThreadSecret",
  "RevokeThreadSecret",
  "UpdateThread",
  "RegenerateTitle",
  "SetGoal",
  "StopBackgroundTask",
  "MarkThreadSeen",
  "SetThreadRead",
  "SetThreadArchived",
  "DeleteThread",
  "RestoreThread",
  "ListModels",
  "ListDirectory",
  "AddProject",
  "CloneProject",
  "GetWorkspaceCloneSource",
  "GetWorkspaceCopyManifest",
  "WorkspaceCopySource",
  "WorkspaceCopyTarget",
  "UpdateWorkspace",
  "RemoveWorkspace",
  "GetAttachment",
  "UploadAttachment",
  "GetThreadBlob",
  "GetVisual",
  "GetThreadSyncContent",
  "ReorderQueuedTurns",
  "EditQueuedTurn",
  "DeleteQueuedTurn",
  "RestoreQueuedTurn",
  "SteerQueuedTurn",
  "ListMentionCatalog",
  "SearchFiles",
  "ListGitRefs",
  "ListThreadBranches",
  "SwitchThreadBranch",
  "ListWorktrees",
  "CleanupWorktrees",
  "RemoveWorktree",
  "RevealWorktree",
  "ReadThreadFile",
  "ListThreadDirectory",
  "GetThreadFileHighlight",
  "WatchThreadFiles",
  "WriteThreadFile",
  "DeleteThreadFile",
  "WatchThreadMirror",
  "AckThreadRange",
  "GetThreadRange",
  "WatchConfig",
  "GetConfigBlob",
  "ListBots",
  "CreateBot",
  "GetBot",
  "GetBotDraft",
  "SaveBotDraft",
  "WatchBotConversation",
  "SendBotMessage",
  "AnswerBotApproval",
  "ListBotApprovalRules",
  "ListThreadApprovals",
  "DeleteBotApprovalRule",
  "UpdateBot",
  "InterruptBot",
  "RetryBot",
  "MarkBotRead",
  "ArchiveBot",
  "UnarchiveBot",
  "DeleteBot",
  "ReadBotExchange",
  "SetBotRoutineEnabled",
  "DeleteBotRoutine",
  "CancelBotReminder",
  "WatchBotMirror",
  "CallAgentBus",
  "GetBotProviderInstances",
  "PrepareMove",
  "DecideMove",
  "MoveOutcome",
  "InspectMove",
  "RenameWorker",
  "SetInstanceWorker",
  "SetWorkerCliUpdateSettings",
  "SetEnvironmentTags",
  "GetWorktreeSettings",
  "UpdateWorktreeSettings",
  "SetConnectorAccess",
  "RefreshProviders",
  "InstallCli",
  "CheckCliUpdates",
  "ListSchedules",
  "CreateSchedule",
  "UpdateSchedule",
  "SetScheduleStatus",
  "GetInstanceWorker",
  "GetWorkerEnvironment",
  "SetWorkerEnvironmentOverride",
  "GetComputerUpdates",
  "RequestComputerUpdate",
]);

/** A linked computer's app and its updates (capability remote_app_update): direct links only, never relayed. */
export const UPDATE_METHODS = new Set(["GetComputerUpdates", "RequestComputerUpdate"]);

/**
 * Stage 6 (shared configuration): a worker's settings, changed at its home over a link that carries
 * configuration. Every worker and workspace id must be the home's; both computers audit the edit.
 * SetInstanceWorkers and SetConnectorAccess with workers of several computers are split by the caller.
 */
// StartProviderLogin is deliberately absent here and from SERVED: a sign-in replaces the CLI login of that computer,
// so only its own owner starts it on its own gateway, never a linked computer.
export const WORKER_SETTINGS = new Set([
  "GetInstanceWorker",
  "GetWorkerEnvironment",
  "SetWorkerEnvironmentOverride",
  "RenameWorker",
  "SetInstanceWorker",
  "SetWorkerCliUpdateSettings",
  "SetEnvironmentTags",
  "GetWorktreeSettings",
  "UpdateWorktreeSettings",
  "SetConnectorAccess",
  "RefreshProviders",
  "InstallCli",
  "CheckCliUpdates",
]);

/** Stage 8: the two sides of a move, direct partners only (never relayed). */
export const MOVE_METHODS = new Set(["PrepareMove", "DecideMove", "MoveOutcome", "InspectMove"]);

export const methodNamed = (name: string) =>
  ui.GatewayService.methods.find((m) => m.name === name) ??
  link.ThreadMirrorService.methods.find((m) => m.name === name) ??
  link.LinkedAgentsService.methods.find((m) => m.name === name) ??
  link.ConfigSyncService.methods.find((m) => m.name === name) ??
  link.ComputerMoveService.methods.find((m) => m.name === name) ??
  link.ComputerUpdateService.methods.find((m) => m.name === name) ??
  link.DiagnosticsService.methods.find((m) => m.name === name);

/** Link messages have already been decoded; verify their descriptor before accessing a concrete message. */
export function linkedMessage<D extends DescMessage>(desc: D, message: Message): MessageShape<D> {
  if (!isMessage(message, desc)) throw new ConnectError("Unexpected linked message type", Code.Internal);

  return message;
}

/** Stage 8: a call named things that moved to another computer. The caller follows the redirect; the items cross relays. */
export class MovedError extends ConnectError {
  constructor(
    readonly items: link.MovedItem[],
    message = `Moved to ${items[0]?.homeName || "another computer"}`,
  ) {
    super(message, Code.FailedPrecondition);
  }
}

/** ConnectError's `instanceof` matches any ConnectError, so moved errors are told apart by their items. */
export const movedItems = (cause: unknown): link.MovedItem[] | undefined =>
  cause instanceof ConnectError &&
  "items" in cause &&
  Array.isArray(cause.items) &&
  cause.items.length &&
  cause.items.every((item): item is link.MovedItem => isMessage(item, link.MovedItemSchema))
    ? cause.items
    : undefined;

export const BOT_METHODS = new Set([
  "ListBots",
  "GetBot",
  "GetBotDraft",
  "SaveBotDraft",
  "WatchBotConversation",
  "SendBotMessage",
  "AnswerBotApproval",
  "ListBotApprovalRules",
  "DeleteBotApprovalRule",
  "UpdateBot",
  "InterruptBot",
  "RetryBot",
  "MarkBotRead",
  "ArchiveBot",
  "UnarchiveBot",
  "DeleteBot",
  "ReadBotExchange",
  "SetBotRoutineEnabled",
  "DeleteBotRoutine",
  "CancelBotReminder",
  "WatchBotMirror",
  "GetBotProviderInstances",
]);
