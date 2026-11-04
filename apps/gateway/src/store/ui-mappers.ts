import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { InteractionKind, PermissionMode, UsageSchema, ui } from "@canopy/contracts";
import { fromJson } from "@bufbuild/protobuf";
import { Match, Predicate } from "effect";
import { classifyFailure, safeFailureDetail } from "@canopy/domain";
import { toUiAttachment } from "./attachments.ts";
import { toUiQuote } from "./quotes.ts";
import { mentionsFromJson } from "../core/mentions.ts";
import { providerOf } from "./instance-config.ts";
import type { InteractionRow, ThreadRow, TurnRow } from "./rows.ts";

export function toInteraction(row: InteractionRow): ui.Interaction {
  return create(ui.InteractionSchema, {
    requestId: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id ?? "",
    itemId: row.item_id ?? "",
    kind: Match.value(row.kind).pipe(
      Match.when("permission", () => InteractionKind.PERMISSION),
      Match.when("question", () => InteractionKind.QUESTION),
      Match.orElse(() => InteractionKind.ELICITATION),
    ),
    toolName: row.tool_name,
    requestJson: JSON.stringify(row.request),
    status: row.status,
    routedTo: row.routed_to,
    createdAt: timestampFromDate(new Date(row.created_at)),
    asynchronous: row.question_wait === false,
  });
}

export function interactionKind(kind: InteractionKind): string {
  return kind === InteractionKind.QUESTION
    ? "question"
    : kind === InteractionKind.ELICITATION
      ? "elicitation"
      : "permission";
}

/** A stored mode (PermissionMode enum name, as in threads.settings); '' or unknown = UNSPECIFIED. */
const permissionModes = new Map(
  Object.entries(PermissionMode).flatMap(([name, mode]) => (Predicate.isNumber(mode) ? [[name, mode] as const] : [])),
);

export function permissionModeOf(name: string | undefined): PermissionMode {
  const mode = permissionModes.get(name ?? "");

  return mode === undefined || mode === PermissionMode.UNSPECIFIED ? PermissionMode.UNSPECIFIED : mode;
}

/** The stored name of a mode; UNSPECIFIED = '' (the thread's default). */
export function permissionModeName(mode: PermissionMode): string {
  return mode === PermissionMode.UNSPECIFIED ? "" : (PermissionMode[mode] ?? "");
}

export function toUiThread(row: ThreadRow): ui.Thread {
  return create(ui.ThreadSchema, {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind === "side" || row.remote_parent_ref ? ui.ThreadKind.SIDE : ui.ThreadKind.MAIN,
    parentThreadId: row.parent_thread_id ?? (row.remote_parent_kind === "thread" ? (row.remote_parent_ref ?? "") : ""),
    title: row.title,
    titleSource: row.title_source,
    provider: providerOf(row.provider),
    providerProfileId: row.provider_profile_id ?? "",
    model: row.settings.model ?? "",
    effort: row.settings.effort ?? "",
    permissionMode: permissionModeOf(row.settings.permissionMode || "ASK"),
    workerId: row.worker_id ?? "",
    workspaceId: row.workspace_id ?? "",
    cwd: row.cwd ?? "",
    status: row.status,
    agentId: row.agent_id ?? "",
    spawnedByAgent: row.origin === "agent",
    scheduleId: row.schedule_id ?? "",
    scheduleName: row.schedule_name ?? "",
    scheduleRun: row.schedule_run ?? 0,
    statusDetail: row.status_detail ?? "",
    lastSeq: BigInt(row.last_seq),
    createdAt: timestampFromDate(new Date(row.created_at)),
    pendingInteractions: Number(row.pending_interactions ?? 0),
    forkSourceThreadId: row.fork_source_thread_id ?? "",
    forkAfterTurnId: row.fork_after_turn_id ?? "",
    forkAfterTurnOrdinal: row.fork_after_turn_ordinal ?? 0,
    rootThreadId: row.root_thread_id,
    interactionRoute: row.interaction_route,
    ...(row.last_activity_at && { lastActivityAt: timestampFromDate(new Date(row.last_activity_at)) }),
    goalStatus: row.goal_status ?? "",
    backgroundTasks: Number(row.background_tasks ?? 0),
    runtime: row.runtime,
    lastMessage: row.last_message ?? "",
    unseenResult: row.unseen_result ?? "",
    markedUnread: row.marked_unread ?? false,
    ...(row.archived_at && { archivedAt: timestampFromDate(new Date(row.archived_at)) }),
    archivedBy: row.archived_by ?? "",
    archivedByThreadId: row.archived_by_thread_id ?? "",
    archivedByThreadTitle: row.archived_by_thread_title ?? "",
    ...(row.deleted_at && { deletedAt: timestampFromDate(new Date(row.deleted_at)) }),
    lastTurnStatus: row.last_turn_status ?? "",
    ...(row.worktree && {
      worktree: {
        id: row.worktree.id,
        branch: row.worktree.branch,
        path: row.worktree.path,
        baseRef: row.worktree.base_ref,
        repoRoot: row.worktree.repo_root,
        workerId: row.worktree.worker_id,
        createdAt: timestampFromDate(new Date(row.worktree.created_at)),
        ...(row.worktree.removed_at && { removedAt: timestampFromDate(new Date(row.worktree.removed_at)) }),
      },
    }),
  });
}

/** Joined columns describing the thread an agent's steer or turn came from (ui.AgentSender). */
export interface SenderColumns {
  source_thread_id?: string | null;
  source_title?: string | null;
  source_provider?: string | null;
  source_profile_id?: string | null;
  source_model?: string | null;
  source_project_id?: string | null;
  source_worker_id?: string | null;
}

export function toUiSender(row: SenderColumns): ui.AgentSender | undefined {
  if (!row.source_thread_id || row.source_title == null) return undefined;

  return create(ui.AgentSenderSchema, {
    threadId: row.source_thread_id,
    title: row.source_title,
    provider: providerOf(row.source_provider),
    providerProfileId: row.source_profile_id ?? "",
    model: row.source_model ?? "",
    projectId: row.source_project_id ?? "",
    workerId: row.source_worker_id ?? "",
  });
}

export function toUiTurn(row: TurnRow & { inherited?: boolean }): ui.Turn {
  // Agent-sent input (a task, a message, a report) names its sender; other sources show their own way.
  const sender =
    row.source_kind === "task" ||
    row.source_kind === "message" ||
    row.source_kind === "report" ||
    (row.source_kind === "answer" && row.source_thread_id)
      ? toUiSender(row)
      : undefined;

  return create(ui.TurnSchema, {
    id: row.id,
    ordinal: row.ordinal,
    status: row.status,
    trigger: row.trigger,
    inputText: row.input?.text ?? "",
    error: safeFailureDetail(row.error ?? ""),
    interruptReason: row.status === "interrupted" ? (row.interrupt_reason ?? "") : "",
    errorSource: row.status === "failed" ? (row.error_source ?? "") : "",
    errorCode: row.status === "failed" ? (row.error_code ?? "") : "",
    errorClass: row.status === "failed" ? classifyFailure(row.error ?? "", row.error_code ?? "") : "",
    interruptSource: row.status === "interrupted" ? (row.interrupt_source ?? "") : "",
    queuedAt: timestampFromDate(new Date(row.queued_at)),
    ...(row.started_at && { startedAt: timestampFromDate(new Date(row.started_at)) }),
    ...(row.completed_at && { completedAt: timestampFromDate(new Date(row.completed_at)) }),
    ...(row.usage && { usage: fromJson(UsageSchema, row.usage) }),
    hops: row.hops ?? 0,
    inherited: row.inherited ?? false,
    fromThreadId: row.inherited ? row.thread_id : "",
    messageText: row.input?.message ?? row.input?.text ?? "",
    platformNote: row.input?.note ?? "",
    sourceStatus: row.source_status ?? "",
    questionKind: row.question_kind ?? "",
    questionTool: row.question_tool ?? "",
    backgroundItemIds: row.background_item_ids ?? [],
    botId: row.bot_id || row.answer_bot_id || "",
    sourceKind: row.source_kind ?? "",
    sourceThreadId: row.source_thread_id ?? "",
    scheduleId: row.schedule_id ?? "",
    interactionRequestId: row.interaction_request_id ?? "",
    model: row.model ?? "",
    effort: row.effort ?? "",
    permissionMode: permissionModeOf(row.permission_mode),
    goalId: row.goal_id ?? "",
    attachments: (row.input?.attachments ?? []).map(toUiAttachment),
    withdrawn: row.withdrawn ?? "",
    revision: row.revision ?? 0,
    mentions: mentionsFromJson(row.input?.mentions),
    quotes: (row.input?.quotes ?? []).map(toUiQuote),
    ...(sender && { sender }),
  });
}
