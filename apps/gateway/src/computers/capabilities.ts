export const DIAGNOSTICS_LOGS = "diagnostics_logs_v1";
export const DIAGNOSTICS_TRACE = "diagnostics_trace_v1";
export const AGENT_PREVIEW_CLIENT_ACK = "agent_preview_client_ack_v1";

/** Local accounting snapshots over authenticated direct links. */
export const USAGE_STATS = "usage_stats_v1";

export const BOT_THREAD_ACCESS = "bot_thread_access_v1";

/** A live hello also tells subscribers when to suspend their history stream. */
export const MIRROR_PAUSED = {
  threads: "thread_mirror_paused",
  bots: "bot_mirror_paused",
} as const;
