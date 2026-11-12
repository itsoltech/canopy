import type { JsonValue } from "@bufbuild/protobuf";
import type { StoredAttachment } from "./attachments.ts";
import type { StoredQuote } from "./quotes.ts";
import type { StoredMentions } from "../core/mentions.ts";

export interface ThreadRow {
  newest_pull_request?: JsonValue | null;
  pull_request_count?: number;
  pull_request_revision?: bigint;
  project_kind?: string;
  id: string;
  project_id: string;
  owner_user_id: string;
  kind: "main" | "side";
  parent_thread_id: string | null;
  remote_parent_ref?: string | null;
  remote_parent_kind?: string | null;
  remote_parent_detached?: boolean;
  root_thread_id: string;
  depth: number;
  origin: string;
  schedule_id?: string | null;
  schedule_name?: string;
  schedule_run?: number | null;
  interaction_route: "human" | "parent";
  agent_id: string | null;
  runtime: string;
  provider: string;
  provider_profile_id: string | null;
  worker_id: string | null;
  workspace_id: string | null;
  cwd: string | null;
  provider_thread_id: string | null;
  fork_source_thread_id: string | null;
  fork_after_turn_id: string | null;
  /** Joined: the fork point's number in the thread it belongs to (fork_source_thread_id). */
  fork_after_turn_ordinal?: number | null;
  settings: {
    model?: string;
    effort?: string;
    permissionMode?: string;
    permissionModeNote?: string;
    instructions?: string;
    handoff?: string;
    branchNote?: string;
  };
  status: string;
  status_detail: string | null;
  title: string;
  title_source: "provisional" | "generated" | "user";
  title_revision: bigint;
  title_requested: boolean;
  title_context: string;
  last_seq: bigint;
  created_at: Date;
  archived_at?: Date | null;
  archived_by?: string | null;
  archived_by_thread_id?: string | null;
  archived_by_thread_title?: string | null;
  deleted_at?: Date | null;
  marked_unread?: boolean;
  pending_interactions?: bigint | number;
  /** Joined from the outbox: a queued turn has been dispatched. */
  turn_starting?: boolean;
  last_activity_at?: Date | null;
  /** Joined: status of the open goal, running background tasks. */
  goal_status?: string | null;
  background_tasks?: bigint | number;
  /** Joined for side threads: the start of the last agent message (a subagent's result). */
  last_message?: string | null;
  /** Joined: the latest ended turn the owner has not seen, with its last answer and error. */
  unseen_turn?: UnseenTurnColumns | null;
  /** Joined: the newest pending request routed to a person. */
  notice_interaction?: NoticeInteractionColumns | null;
  /** Joined: how the latest ended turn ended. */
  last_turn_status?: string | null;
  /** The git worktree the thread works in (docs/worktrees.md); NULL = the workspace's checkout. */
  worktree_id?: string | null;
  /** Joined: that worktree. */
  worktree?: ThreadWorktreeColumns | null;
  /** Joined for a thread without a worktree: the workspace checkout's live HEAD (checkout_heads). */
  checkout_head?: { branch: string; detached_commit: string } | null;
  /** Joined: the thread came from a CLI import (thread_imports, docs/import.md). */
  imported?: { agent_cli: string; mode: string; imported_at: string } | null;
}

export interface UnseenTurnColumns {
  status: string;
  interrupt_source: string | null;
  error: string | null;
  message: string | null;
}

export interface NoticeInteractionColumns {
  kind: string;
  tool: string;
  request: JsonValue;
}

/** The thread's worktree as joined by threadSelect (json_build_object: timestamps are strings). */
export interface ThreadWorktreeColumns {
  external?: boolean;
  id: string;
  branch: string;
  path: string;
  base_ref: string;
  repo_root: string;
  worker_id: string;
  created_at: string;
  removed_at?: string | null;
  detached_commit?: string;
  branch_source?: string;
}

export interface TurnRow {
  id: string;
  /** The bot that started or sent the turn (trigger bot), when the query joins it. */
  bot_id?: string | null;
  /** Joined from turn_sources: the bot that answered this turn's ask_user on the user's behalf. */
  answer_bot_id?: string | null;
  thread_id: string;
  ordinal: number;
  status: string;
  trigger: string;
  /** Derived from the worker outbox, including the gap before turn_started. */
  dispatched?: boolean;
  /**
   * text = what the model got; note + message = the same split for the UI (platform-queued turns, a message with
   * attachments or quotes: the note lists them); attachments = the files of the message, with their paths on the
   * worker; quotes = the passages of the thread it quotes (shown to the model in the note).
   */
  input: {
    shellCommand?: string;
    shellInputId?: string;
    shellResult?: JsonValue;
    /** Pending checkout context, restored if a shell input fails before the agent starts. */
    branchNote?: string;
    text?: string;
    note?: string;
    message?: string;
    attachments?: StoredAttachment[];
    quotes?: StoredQuote[];
    sender?: JsonValue;
    sourceKind?: string;
    sourceStatus?: string;
  } & StoredMentions;
  /** The message's override while queued; the values sent to the worker once started ('' = default). */
  model?: string;
  effort?: string;
  /** Same as model: the override ('' = the thread's default), then the mode sent (PermissionMode enum name). */
  permission_mode?: string;
  error: string | null;
  /** failed: platform | harness; interrupted: user | system (docs/durability.md, "Stany tury i wątku"). */
  error_source?: string | null;
  error_code?: string | null;
  interrupt_reason?: string | null;
  interrupt_source?: string | null;
  provider_turn_ref: string | null;
  queued_at: Date;
  started_at?: Date | null;
  completed_at?: Date | null;
  usage?: JsonValue | null;
  hops?: number;
  schedule_id?: string | null;
  agent_call_id?: string | null;
  interaction_request_id?: string | null;
  goal_id?: string | null;
  /** Joined from turn_sources (with the sender's thread: SenderColumns). */
  source_kind?: string | null;
  source_thread_id?: string | null;
  source_title?: string | null;
  source_provider?: string | null;
  source_profile_id?: string | null;
  source_model?: string | null;
  source_project_id?: string | null;
  source_worker_id?: string | null;
  source_status?: string | null;
  question_kind?: string | null;
  question_tool?: string | null;
  /** Joined from turn_sources: a background_task turn's tasks (item ids). */
  background_item_ids?: string[] | null;
  /** Withdrawn before entry (cancelled): deleted | steered | consumed (bus result read). */
  withdrawn?: string | null;
  /** Grows with every edit of the queued input. */
  revision?: number;
}

export interface OutboxRow {
  id: string;
  worker_id: string;
  thread_id: string | null;
  turn_id: string | null;
  kind: string;
  payload: Uint8Array;
}

/** jsonb written when an interaction is answered (`answerInteraction`). */
export interface InteractionResponse {
  allow?: boolean;
  allowForSession?: boolean;
  message?: string;
  answerJson?: string;
  cancelled?: boolean;
}

export interface InteractionRow {
  expires_at?: Date | null;
  id: string;
  thread_id: string;
  turn_id: string | null;
  item_id: string | null;
  kind: string;
  tool_name: string;
  request: JsonValue;
  status: string;
  routed_to: string;
  response: InteractionResponse | null;
  created_at: Date;
  answered_by?: string | null;
  answered_by_thread_id?: string | null;
  question_call_id?: string | null;
  question_wait?: boolean | null;
  answer_delivery?: string | null;
  answer_steer_id?: string | null;
  answer_turn_id?: string | null;
}
