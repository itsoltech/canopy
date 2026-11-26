export const DIAGNOSTICS_LOGS = "diagnostics_logs_v1";
export const DIAGNOSTICS_TRACE = "diagnostics_trace_v1";
export const AGENT_PREVIEW_CLIENT_ACK = "agent_preview_client_ack_v1";

/** Local accounting snapshots over authenticated direct links. */
export const USAGE_STATS = "usage_stats_v1";

export const BOT_THREAD_ACCESS = "bot_thread_access_v1";

/** A thread-panel write changes the thread's project grant. */
export const PROJECT_CONNECTOR_ACCESS = "project_connector_access_v1";

export const ISSUE_SEARCH = "issue_search_v1";

/** This gateway classifies bot and thread callers before dispatch and checks the origin on forwarded calls. */
export const AGENT_MEMORY_AUDIENCE = "agent_memory_audience_v1";
export const AGENT_START_THREAD = "agent_start_thread_v1";

/** A live hello also tells subscribers when to suspend their history stream. */
export const MIRROR_PAUSED = {
  threads: "thread_mirror_paused",
  bots: "bot_mirror_paused",
} as const;

export const LINKED_DRAFT_SANDBOX_SNAPSHOT = "gateway_draft_sandbox_snapshot_v1";
export const LINKED_SANDBOX_PROFILES = "gateway_sandbox_profiles_v1";
export const LINKED_SCHEDULE_SANDBOX_PROFILES = "gateway_schedule_sandbox_profiles_v1";
