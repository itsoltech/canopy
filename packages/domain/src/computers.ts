/**
 * Ids of things whose home is another linked computer (docs/linked-computers.md, stage 2).
 * The gateway that proxies them appends `~` and the first 16 hex characters of the home's node id,
 * so a browser can hold ids from several computers in one list without ambiguity. Routing happens in
 * the gateway: it strips the suffix and forwards the call to that computer over the pinned link.
 */
export const REMOTE_THREADS = "remote_threads";

/** Account auth only. PR read/write capabilities wait for their complete stages. */
export const GITHUB_ACCOUNTS = "github_accounts_v1";
export const GITHUB_AGENT_ACCESS = "github_agent_access_v1";
export const GITHUB_PR = "github_pr_v1";
export const GITHUB_COMMENTS = "github_pr_comments_v1";
export const GITHUB_REVIEW = "github_pr_review_v1";
export const GITHUB_LIFECYCLE = "github_pr_lifecycle_v1";
export const GITHUB_METADATA = "github_pr_metadata_v1";
export const GITHUB_WRITE = "github_pr_write_v1";

/** Routing-only marker for account lists and sign-in before an account exists. */
export const GITHUB_HOME = "00000000-0000-4000-8000-000000000001";
export const REMOTE_WORKTREES = "remote_worktrees";
export const REMOTE_GIT_STATUS = "remote_git_status_v1";
export const REMOTE_BRANCH_SWITCH = "remote_branch_switch_v1";
export const REMOTE_BRANCH_STASH = "remote_branch_stash_v1";
export const REMOTE_WORKSPACE_BRANCH_SWITCH = "remote_workspace_branch_switch_v1";
export const THREAD_MIRROR = "thread_mirror";
export const THREAD_MIRROR_DELTA = "thread_mirror_delta";
export const THREAD_RANGES = "thread_ranges_v1";
export const THREAD_WATCH_LIVENESS = "thread_watch_liveness";
export const THREAD_WATCH_COALESCE = "thread_watch_coalesce";
export const REMOTE_BOTS = "remote_bots";

/** Durable bot drafts and image messages; every forwarding computer must understand the fields. */
export const REMOTE_BOT_COMPOSER = "remote_bot_composer_v1";
export const REMOTE_THREAD_PANEL = "remote_thread_panel_v1";
export const AGENT_BUS = "agent_bus";

/** Stage 6: the computer accepts `RouteAnnouncement` frames (its partner's current addresses). */
export const LAN_ROUTES = "lan_routes";

/** Stage 7: opt-in forwarding through exactly one trusted intermediary. */
export const RELAY = "relay";

/**
 * Messages may place their attachments in the text (MentionKind.ATTACHMENT). A home without it gets the same message
 * with the badges left as plain text. Not offered through a relay: older intermediaries refuse unknown features.
 */
export const INLINE_ATTACHMENTS = "inline_attachments";

/** The home accepts attachment steers and reports a queued fallback when its worker cannot take them. */
export const STEER_ATTACHMENTS = "steer_attachments_v1";

/** Stage 8: two-phase moves of threads and bots between directly linked computers, and redirects. */
export const MOVE_ITEMS = "move_items";

/** A moved thread continues its own harness session and files on the target's worker (docs/thread-transfers.md). */
export const MOVE_NATIVE_SESSIONS = "move_native_sessions_v1";

/** The target accepts a moved bot's event triggers (routines of kind trigger, without a cron). */
export const MOVE_BOT_TRIGGERS = "move_bot_triggers_v1";

/** The receiving gateway retains a bot's learned skills and their revision history. */
export const MOVE_BOT_SKILLS = "move_bot_skills_v1";

/** Remote app updates: a directly linked computer's Canopy app updates on request (docs/updates.md). */
export const REMOTE_APP_UPDATE = "remote_app_update";

/** The receiving gateway preserves the CLI's no-downgrade request. */
export const REMOTE_CLI_UPGRADE_ONLY = "remote_cli_upgrade_only";
export const NODE_REF_LENGTH = 16;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const QUALIFIED = /^(.+)~([0-9a-f]{16})$/;
const ENTITY = new RegExp(`^${UUID}(?:~[0-9a-f]{16})?$`, "i");
const PLAIN = new RegExp(`^${UUID}$`, "i");

export const nodeRef = (nodeId: string): string => nodeId.slice(0, NODE_REF_LENGTH);

/** A local uuid gets the home's suffix; anything else (provider ids, already qualified ids) is kept. */
export const qualifyId = (id: string, nodeId: string): string => (PLAIN.test(id) ? `${id}~${nodeRef(nodeId)}` : id);

/** `{ id, node }` for a qualified id, `{ id }` for a local one. */
export function splitId(value: string): { id: string; node?: string } {
  const match = QUALIFIED.exec(value);

  return match ? { id: match[1]!, node: match[2]! } : { id: value };
}

/** A uuid of this computer or of a linked one (sidebar pins, queue order, fork points). */
export const isEntityId = (value: string): boolean => ENTITY.test(value);

/** Per-field configuration across direct links whose two ends share configuration. */
export const CONFIG_SYNC = "config_sync";
