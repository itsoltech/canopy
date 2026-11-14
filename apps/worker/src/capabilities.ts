import {
  STEER_ATTACHMENTS_CAPABILITY,
  THREAD_VISUALS_CAPABILITY,
  THREAD_HTML_CAPABILITY,
} from "@canopy/domain/release/protocol";

/** What this worker announces in Hello; the gateway sends a command only to workers that announce it. */
export function workerCapabilities(options: { localWorker: boolean; fullAccess: boolean }): string[] {
  return [
    // running_turns: the list below is complete, the gateway ends its other running turns of this worker.
    // probe_providers, codex_device_login: provider instances are checked again and sign in from the app;
    // codex_device_login_linked: also an instance that uses the device login (the device's Codex signs in again).
    // attachments: turns may carry files (fetched with FetchBlob into attachments_root).
    // cli_install: provider CLIs are reported (CliToolsReport) and installed on demand (InstallCli).
    // worktrees: git refs and worktrees of workspaces (docs/worktrees.md), under worktrees_root by default.
    // project_sources: new project directories (git init) and clones (InitRepository, CloneRepository).
    "diagnostics_logs_v1",
    "diagnostics_trace_v1",
    "diagnostics_v1",
    "worker_diagnostics_v1",
    "shell_input_v1",
    "provider_account_status",
    "running_turns",
    "thread_lifecycle_v1",
    "thread_rewind_v1",
    "attachments",
    STEER_ATTACHMENTS_CAPABILITY,
    "probe_providers",
    "codex_device_login",
    "codex_device_login_linked",
    "provider_cli_auth_v1",
    "generate_text",
    "bot_harness_v1",
    "bot_web_v1",
    "bot_workspace_v1",
    "bot_outgoing_files_v1",
    "bot_images_v1",
    "bot_files_v1",
    "thread_secrets",
    "cli_install",
    // desktop_bundled: the desktop app's own local-mode worker, updated with the app (docs/updates.md).
    ...(options.localWorker ? ["desktop_bundled"] : ["network_route_migration"]),
    "agent_environment_v1",
    "agent_skills_v1",
    "agent_plugins_v1",
    "worktrees",
    "workspace_origin",
    "workspace_clone_source",
    "worktree_lifecycle",
    "git_worktree_discovery",
    // git_heads: the live branch of thread checkouts (GitHeads).
    "git_heads",
    "git_pr_context_v1",
    "git_branch_switch_v1",
    // reveal_path: RevealPath opens a thread's directory in this computer's file manager.
    "reveal_path",
    // thread_files_v1: read, write, delete and open a thread's files (ReadFile and the others).
    "thread_files_v1",
    "thread_image_replies_v1",
    "thread_file_preview_v1",
    "thread_directory_v1",
    "thread_file_highlight_v1",
    "thread_files_watch_v1",
    // thread_visuals_v1: render_visual is offered to every harness; the gateway validates and stores it.
    THREAD_VISUALS_CAPABILITY,
    THREAD_HTML_CAPABILITY,
    // provisional_branches: RenameWorktreeBranch.provisional keeps pushed or switched branches.
    "provisional_branches",
    "project_sources",
    "git_clone_progress_v1",
    "workspace_copy_v1",
    "workspace_copy_scope_v2",
    // cli_import_v1: Settings → Import reads the device's CLI homes on request (docs/import.md).
    "cli_import_v1",
    // cli_import_library_v1: the scan also lists settings and library items, and reads them on request.
    "cli_import_library_v1",
    // full_access: PERMISSION_MODE_FULL_ACCESS runs unsandboxed; not announced when worker.json turns it off.
    ...(options.fullAccess ? ["full_access"] : []),
  ];
}
