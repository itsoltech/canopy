/** Peer I/O never contributes to the latency of local aggregate reads. */
export const PEER_READ_TIMEOUT_MS = 10_000;
export const PEER_UPDATE_CHECK_TIMEOUT_MS = 120_000;
export const PEER_UPDATE_INSTALL_TIMEOUT_MS = 15 * 60_000;
export const PEER_READ_REFRESH_MS = 5000;
export const PEER_READ_RETRY_MS = 30_000;
export const PEER_BACKOFF_MS = 30_000;
export const PEER_MAX_BACKOFF_MS = 3 * 60_000;
export const PEER_PING_INTERVAL_MS = 15_000;
export const PEER_PING_TIMEOUT_MS = 10_000;
export const PEER_HEARTBEAT_MS = 5000;
export const PEER_ROUTE_FLUSH_MS = 100;
export const PEER_ROUTE_ROTATION_WINDOW_MS = 5000;
export const PEER_CONNECT_TIMEOUT_MS = 5000;
export const PEER_HANDSHAKE_TIMEOUT_MS = 8000;
export const PEER_IDLE_CONNECTION_TIMEOUT_MS = 1000;
export const PEER_MUTATION_TIMEOUT_MS = 30_000;
export const PEER_WATCH_HEARTBEAT_MS = 5000;
export const PEER_WATCH_TIMEOUT_MS = 15_000;
export const PEER_WATCH_LEGACY_PROBE_MS = 30_000;

/** Explicit operations can be slow without delaying any local list or page. */
export const PEER_LONG_CALL_TIMEOUTS = new Map([
  ["SwitchThreadBranch", 150_000],
  ["AddProject", 61 * 60_000],
  ["CreateThread", 120_000],
  ["ListWorktrees", 120_000],
  ["CleanupWorktrees", 300_000],
]);
