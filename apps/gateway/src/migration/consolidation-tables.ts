import { memoryImportTables, reflectionSourceTables } from "./consolidation-memory.ts";

export interface ImportTable {
  name: string;
  filter: string;
  secret?: string;
  // Merge scopes are resolved against the selected target owner before rebasing its ID.
  matchAfterRebase?: boolean;
  merge?: { owner: string; match: string; update: readonly string[] };
  sequence?: "id" | "seq";
  idKind?: string;
}

const owned = "s.owner_user_id=$1::uuid";

const thread = (column = "thread_id") =>
  `EXISTS (SELECT 1 FROM public.threads t WHERE t.id=s.${column} AND t.owner_user_id=$1::uuid AND t.moved_to IS NULL)`;

const bot = (column = "bot_id") =>
  `EXISTS (SELECT 1 FROM public.bots b WHERE b.id=s.${column} AND b.owner_user_id=$1::uuid AND b.moved_to IS NULL)`;

const worker = (column = "worker_id") =>
  `EXISTS (SELECT 1 FROM public.workers w WHERE w.id=s.${column} AND w.owner_user_id=$1::uuid)`;

const project = (column = "project_id") =>
  `EXISTS (SELECT 1 FROM public.projects p WHERE p.id=s.${column} AND p.owner_user_id=$1::uuid)`;

const botTurn = (column = "turn_id") =>
  `EXISTS (SELECT 1 FROM public.bot_turns bt JOIN public.bots b ON b.id=bt.bot_id
    WHERE bt.id=s.${column} AND b.owner_user_id=$1::uuid AND b.moved_to IS NULL)`;

const schedule = `EXISTS (SELECT 1 FROM public.schedules a JOIN public.projects p ON p.id=a.project_id
  WHERE a.id=s.schedule_id AND p.owner_user_id=$1::uuid AND (a.thread_id IS NULL OR EXISTS (
    SELECT 1 FROM public.threads t WHERE t.id=a.thread_id AND t.owner_user_id=p.owner_user_id AND t.moved_to IS NULL)))`;

const connector = `EXISTS (SELECT 1 FROM public.connector_accounts a WHERE a.id=s.account_id AND a.owner_user_id=$1::uuid)`;
const attachment = `${owned} AND (s.thread_id IS NULL OR ${thread()}) AND (s.bot_id IS NULL OR ${bot()})`;

const sameOwner = "d.owner_user_id=$2::uuid";
const sameId = "d.id=s.id";

const rootTables: ImportTable[] = [
  {
    name: "projects",
    filter: owned,
    idKind: "project",
    merge: {
      owner: sameOwner,
      match: `${sameId} OR (d.kind='scratch' AND s.kind='scratch')
        OR (d.slug=s.slug AND d.kind=s.kind AND d.archived_at IS NULL AND s.archived_at IS NULL)
        OR EXISTS (SELECT FROM public.config_items c JOIN pg_temp.cc_project_identity i ON i.global_id=c.global_id
          WHERE c.owner_user_id=d.owner_user_id AND c.kind='project' AND c.local_id=d.id::text AND i.id=s.id)`,
      update: ["name", "description", "updated_at"],
    },
  },
  { name: "workers", filter: owned, idKind: "worker" },
  { name: "project_workspaces", filter: `${project()} AND ${worker()}`, idKind: "workspace" },
  {
    name: "agents",
    filter: "s.created_by=$1::uuid AND (s.owner_user_id=$1::uuid OR (s.owner_user_id IS NULL AND s.scope='global'))",
    idKind: "agent",
    merge: {
      owner: sameOwner,
      match: `${sameId} OR (d.slug=s.slug AND d.archived_at IS NULL AND s.archived_at IS NULL)`,
      update: [
        "name",
        "description",
        "kind",
        "provider",
        "model",
        "instructions",
        "permission_mode",
        "config",
        "revision",
        "updated_at",
      ],
    },
  },
  { name: "threads", filter: `${owned} AND s.moved_to IS NULL`, idKind: "thread" },
  { name: "bots", filter: `${owned} AND s.moved_to IS NULL`, idKind: "bot" },
  {
    name: "schedules",
    filter: `${project()} AND (s.thread_id IS NULL OR ${thread()})`,
    idKind: "schedule",
  },
  { name: "attachments", filter: attachment, idKind: "attachment" },
  {
    name: "user_settings",
    filter: "s.user_id=$1::uuid",
    merge: { owner: "d.user_id=$2::uuid", match: "true", update: ["settings", "version", "updated_at"] },
  },
  {
    name: "project_settings",
    filter: project(),
    matchAfterRebase: true,
    merge: {
      owner: `EXISTS (SELECT FROM public.projects p WHERE p.id=d.project_id AND p.owner_user_id=$2::uuid)`,
      match: "d.project_id=s.project_id",
      update: ["settings", "version", "updated_by", "updated_at"],
    },
  },
  {
    name: "secrets",
    filter: owned,
    secret: "ciphertext",
    idKind: "secret",
    merge: {
      owner: sameOwner,
      match: `${sameId} OR d.name=s.name`,
      update: ["ciphertext", "key_id", "rotated_at"],
    },
  },
  {
    name: "connector_accounts",
    filter: owned,
    secret: "credentials",
    idKind: "connector",
    merge: {
      owner: sameOwner,
      match: `${sameId} OR (d.namespace=s.namespace AND d.connector_type=s.connector_type)`,
      update: [
        "name",
        "url",
        "transport",
        "auth_kind",
        "credentials",
        "key_id",
        "legacy_headers",
        "status",
        "all_projects",
        "tools",
        "revision",
        "updated_at",
        "error",
        "slack_team_id",
        "slack_refresh_attempt",
        "slack_refresh_started_at",
      ],
    },
  },
  {
    name: "connector_oauth_apps",
    filter: owned,
    secret: "credentials",
    merge: {
      owner: sameOwner,
      match: "d.connector_type=s.connector_type",
      update: ["credentials", "client_id", "updated_at"],
    },
  },
  { name: "proxies", filter: owned },
  {
    name: "provider_instances",
    filter: "NOT s.built_in AND s.created_by=$1::uuid",
    merge: {
      owner: "d.created_by=$2::uuid AND NOT d.built_in",
      match: "d.harness=s.harness AND d.id=s.id",
      update: [
        "label",
        "kind",
        "base_url",
        "api_key",
        "env",
        "runtime",
        "accent_color",
        "favorites",
        "hidden_models",
        "shown_models",
        "custom_models",
        "all_workers",
        "revision",
        "updated_at",
        "proxy_id",
      ],
    },
  },
  { name: "provider_instance_workers", filter: worker() },
];

const threadData = [
  "goals",
  "turns",
  "turn_steers",
  "thread_events",
  "thread_items",
  "thread_blobs",
  "thread_message_receipts",
  "interaction_requests",
  "background_task_notes",
  "computer_moved_threads",
  "thread_transcript_compaction",
];

const botData = ["bot_turns", "bot_routines", "bot_approvals", "bot_handoff_notes", "bot_wakeups"];

const botChannel = (throughConversation = false) => `EXISTS (SELECT FROM public.bot_channel_routes r
  ${throughConversation ? "JOIN public.bot_channel_conversations c ON c.route_id=r.id" : ""}
  JOIN public.bots b ON b.id=r.bot_id WHERE ${throughConversation ? "c.id=s.conversation_id" : "r.id=s.route_id"}
    AND r.owner_user_id=$1::uuid AND b.owner_user_id=r.owner_user_id AND b.moved_to IS NULL)`;

const repoData: ImportTable[] = [
  ...["import_runs", "import_items", "import_library_items"].map((name) => ({ name, filter: owned })),
  { name: "thread_imports", filter: `${owned} AND ${thread()}` },
  { name: "worktrees", filter: `${owned} AND ${project()} AND ${worker()}` },
  {
    name: "worktree_settings",
    filter: owned,
    matchAfterRebase: true,
    merge: {
      owner: sameOwner,
      match: "d.project_id IS NOT DISTINCT FROM s.project_id AND d.worker_id IS NOT DISTINCT FROM s.worker_id",
      update: ["settings", "version", "updated_at"],
    },
  },
  {
    name: "checkout_heads",
    filter: `EXISTS (SELECT FROM public.project_workspaces pw JOIN public.projects p ON p.id=pw.project_id
    JOIN public.workers w ON w.id=pw.worker_id AND w.owner_user_id=p.owner_user_id
    WHERE pw.id=s.workspace_id AND p.owner_user_id=$1::uuid)`,
  },
  { name: "workspace_copies", filter: `${owned} AND ${project()} AND ${worker()}` },
  { name: "workspace_copy_presets", filter: owned },
  { name: "github_accounts", filter: owned, secret: "credentials" },
  { name: "github_installations", filter: owned },
  { name: "github_installation_repositories", filter: owned },
  { name: "github_repository_accounts", filter: owned },
  { name: "github_pull_requests", filter: owned },
  { name: "thread_pull_requests", filter: `${owned} AND ${thread()}` },
  { name: "github_git_contexts", filter: `${owned} AND ${thread()}`, sequence: "id" },
  { name: "pr_check_watches", filter: `${owned} AND ${thread()}` },
  { name: "pr_check_notes", filter: thread() },
];

const ownedBlob = `EXISTS (SELECT FROM public.attachments a
  WHERE (${attachment.replaceAll("s.", "a.")})
    AND (a.sha256=s.sha256 OR a.thumb_sha256=s.sha256))
  OR EXISTS (SELECT FROM public.thread_blobs tb JOIN public.threads t ON t.id=tb.thread_id
    WHERE tb.sha256=s.sha256 AND t.owner_user_id=$1::uuid AND t.moved_to IS NULL)`;

export const importTables: readonly ImportTable[] = [
  ...rootTables,
  ...repoData,
  ...threadData.map((name) => ({ name, filter: thread() })),
  ...botData.map((name) => ({ name, filter: bot() })),
  { name: "thread_reads", filter: `s.user_id=$1::uuid AND ${thread()}` },
  { name: "thread_visuals", filter: `${owned} AND ${thread()}` },
  { name: "thread_rewinds", filter: `${owned} AND ${thread()}` },
  {
    name: "thread_rewind_turns",
    filter: `EXISTS (SELECT FROM public.thread_rewinds r JOIN public.threads t ON t.id=r.thread_id
    WHERE r.id=s.rewind_id AND r.owner_user_id=$1::uuid AND t.owner_user_id=r.owner_user_id AND t.moved_to IS NULL)`,
  },
  { name: "thread_secrets", filter: thread(), secret: "ciphertext" },
  { name: "agent_bus_calls", filter: thread("source_thread_id") },
  { name: "blobs", filter: ownedBlob },
  { name: "schedule_runs", filter: schedule },
  { name: "schedule_worktree_preparations", filter: schedule },
  { name: "worker_configs", filter: worker() },
  { name: "worker_config_history", filter: worker() },
  { name: "worker_config_secrets", filter: worker() },
  { name: "worker_journal_cursors", filter: `${worker()} AND ${thread()}` },
  { name: "worker_event_quarantine", filter: `${worker()} AND ${thread()}` },
  { name: "worker_model_catalogs", filter: worker() },
  { name: "worker_environments", filter: worker() },
  {
    name: "worker_commands",
    filter: `${worker()} AND (s.thread_id IS NULL OR ${thread()})
    AND s.status NOT IN ('pending','delivered')`,
  },
  { name: "bot_started_threads", filter: `${bot()} AND ${thread()}` },
  { name: "bot_approval_rules", filter: `${owned} AND ${bot()}` },
  { name: "bot_tool_calls", filter: botTurn() },
  { name: "bot_messages", filter: `${bot()} AND ${botTurn()}`, sequence: "seq" },
  { name: "bot_thread_watches", filter: `${bot()} AND ${thread("target_thread_id")}` },
  {
    name: "bot_thread_question_deliveries",
    filter: `EXISTS (SELECT FROM public.bot_thread_watches w JOIN public.bots b
    ON b.id=w.bot_id JOIN public.threads t ON t.id=w.target_thread_id WHERE w.call_id=s.call_id
    AND b.owner_user_id=$1::uuid AND t.owner_user_id=b.owner_user_id AND b.moved_to IS NULL AND t.moved_to IS NULL)`,
  },
  { name: "bot_harness_turns", filter: `${bot()} AND ${worker()}` },
  { name: "bot_harness_events", filter: `${botTurn()} AND ${worker()}` },
  { name: "bot_harness_cursors", filter: `${bot()} AND ${worker()}` },
  { name: "bot_mcp_servers", filter: owned },
  { name: "bot_mcp_connections", filter: bot() },
  { name: "bot_composer_drafts", filter: `${owned} AND ${bot()}` },
  { name: "connector_project_grants", filter: `${connector} AND ${project()}` },
  { name: "connector_bot_grants", filter: `${connector} AND ${bot()}` },
  {
    name: "connector_executions",
    filter: `${owned} AND (s.thread_id IS NULL OR ${thread()}) AND (s.bot_id IS NULL OR ${bot()})`,
  },
  { name: "messenger_accounts", filter: owned, secret: "credentials" },
  { name: "bot_channel_routes", filter: `${owned} AND ${bot()}` },
  { name: "bot_channel_conversations", filter: botChannel() },
  ...memoryImportTables,
  { name: "bot_channel_inputs", filter: botChannel(true) },
  { name: "bot_channel_messages", filter: botChannel(true), sequence: "id" },
  {
    name: "messenger_events",
    filter: `EXISTS (SELECT FROM public.messenger_accounts a
    WHERE a.id=s.account_id AND a.owner_user_id=$1::uuid)`,
  },
  { name: "messenger_outbound", filter: `${botChannel(true)} AND s.status NOT IN ('pending','sending')` },
  ...[
    "agent_skills",
    "agent_skill_versions",
    "agent_marketplaces",
    "agent_marketplace_catalogs",
    "agent_plugins",
    "agent_plugin_versions",
    "instruction_documents",
    "instruction_document_versions",
  ].map((name) => ({ name, filter: owned })),
];

// Each table outside the import has an explicit disposition. Identity, client and peer state are
// bound to the old gateway. Runtime projections, queues and clocks are local to their installation.
const localOnly = [
  "users",
  "schema_migrations",
  "gateway_onboarding",
  "network_access",
  "mobile_devices",
  "mobile_pairings",
  "desktop_updates",
  "desktop_worker_migrations",
  "enrollment_tokens",
  "worker_enrollments",
  "worker_connections",
  "worker_ssh_keys",
  "worker_ssh_hosts",
  "worker_secret_delivery_cursors",
  "worker_secret_replays",
  "worker_preview_uploads",
  "computer_identity",
  "computer_peers",
  "computer_routes",
  "computer_pairing_budget",
  "computer_pairings",
  "computer_revocations",
  "computer_relay_grants",
  "computer_moves",
  "computer_redirects",
  "computer_agent_calls",
  "computer_agent_events",
  "computer_bot_mirror_state",
  "computer_mirror_bots",
  "computer_mirror_generations",
  "computer_mirror_state",
  "computer_mirror_threads",
  "computer_thread_changes",
  "computer_thread_clock",
  "computer_thread_panels",
  "thread_mirror_recent_ranges",
  "bot_view_changes",
  "bot_view_clock",
  "config_aliases",
  "config_clock",
  "config_items",
  "config_peer_cursors",
  "config_secrets",
  "config_history",
  "database_maintenance",
  ...reflectionSourceTables,
  "connector_oauth_states",
  "diagnostics_grants",
  "diagnostics_investigations",
  "diagnostics_log_grants",
  "diagnostics_peer_cache",
  "diagnostics_rollups",
  "diagnostics_state",
  "github_api_budgets",
  "github_api_slots",
  "github_detection_jobs",
  "github_device_auth",
  "github_mutation_receipts",
  "github_pr_cache",
  "github_update_accounts",
  "thread_image_publications",
  "thread_publication_failures",
  "thread_range_entities",
  "thread_range_failures",
  "thread_range_state",
  "thread_replication_clock",
  "thread_replication_content",
  "thread_replication_content_leases",
  "thread_replication_entity_content",
  "thread_replication_journal",
  "thread_replication_seed_entities",
  "thread_replication_snapshot_generations",
  "thread_replication_sources",
  "remote_usage_buckets",
  "remote_usage_state",
  "usage_state",
  "agent_marketplace_previews",
  "agent_skill_source_previews",
];

// Available in the archived dump, with a separate disposition for owner-wide history or transient features
// whose scope is not the home of an imported worker/thread/bot.
const archiveOnly = [
  "agent_environments",
  "audit_log",
  "connector_audit",
  "provider_usage",
  "usage_buckets",
  "usage_counters",
  "workspace_copy_jobs",
  "composer_draft_clock",
  "composer_draft_moves",
  "composer_drafts",
  "composer_draft_attachments",
];

export const coveredTables = new Set([
  ...importTables.map((table) => table.name),
  ...localOnly,
  ...archiveOnly,
  "gateway_consolidation_receipts",
  "gateway_consolidation_ids",
  "gateway_relocation_fence",
  "gateway_relocation_receipts",
]);
