// oxlint-disable-next-line typescript/triple-slash-reference -- gateway and integration tests typecheck this file under their own tsconfig; only a reference carries the ambient "*.sql" module declaration with it.
/// <reference path="../sql-modules.d.ts" />
import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import init from "./0001_init.sql" with { type: "text" };
import historyReadIndexes from "./0100_history_read_indexes.sql" with { type: "text" };
import composerTurnChoices from "./0101_composer_turn_choices.sql" with { type: "text" };
import botComposer from "./0102_bot_composer.sql" with { type: "text" };
import configFieldAncestry from "./0110_config_field_ancestry.sql" with { type: "text" };
import workerEventQuarantine from "./0111_worker_event_quarantine.sql" with { type: "text" };
import workspaceCopy from "./0112_workspace_copy.sql" with { type: "text" };
import githubAccounts from "./0113_github_accounts.sql" with { type: "text" };
import githubPullRequests from "./0114_github_pull_requests.sql" with { type: "text" };
import githubDetection from "./0115_github_detection.sql" with { type: "text" };
import githubFullRead from "./0116_github_full_read.sql" with { type: "text" };
import githubMutations from "./0117_github_mutations.sql" with { type: "text" };
import githubReviews from "./0118_github_reviews.sql" with { type: "text" };
import githubLifecycle from "./0119_github_lifecycle.sql" with { type: "text" };
import threadRanges from "./0120_thread_ranges.sql" with { type: "text" };
import threadRangeLockOrder from "./0124_thread_range_lock_order.sql" with { type: "text" };
import threadPublicationFailures from "./0121_thread_publication_failures.sql" with { type: "text" };
import threadClientCursors from "./0122_thread_client_cursors.sql" with { type: "text" };
import threadSyncDiagnostics from "./0123_thread_sync_diagnostics.sql" with { type: "text" };
import inheritedAccessMode from "./0125_inherited_access_mode.sql" with { type: "text" };
import botViewDelta from "./0091_bot_view_delta.sql" with { type: "text" };
import workerConfig from "./0002_worker_config.sql" with { type: "text" };
import gatewayRuntime from "./0003_gateway_runtime.sql" with { type: "text" };
import agentBusRuntime from "./0004_agent_bus_runtime.sql" with { type: "text" };
import settings from "./0005_settings.sql" with { type: "text" };
import turnSources from "./0006_turn_sources.sql" with { type: "text" };
import turnSourceDetails from "./0007_turn_source_details.sql" with { type: "text" };
import oneStartPerTurn from "./0008_one_start_per_turn.sql" with { type: "text" };
import modelsEffortSteer from "./0009_models_effort_steer.sql" with { type: "text" };
import goalsBackgroundHarness from "./0010_goals_background_harness.sql" with { type: "text" };
import goalsEngineCleanup from "./0011_goals_engine_cleanup.sql" with { type: "text" };
import workerRestart from "./0012_worker_restart.sql" with { type: "text" };
import turnEndSources from "./0013_turn_end_sources.sql" with { type: "text" };
import turnPermissionMode from "./0014_turn_permission_mode.sql" with { type: "text" };
import providerProfiles from "./0015_provider_profiles.sql" with { type: "text" };
import attachments from "./0016_attachments.sql" with { type: "text" };
import globalProviders from "./0018_global_providers.sql" with { type: "text" };
import threadReads from "./0019_thread_reads.sql" with { type: "text" };
import forkFromTurn from "./0020_fork_from_turn.sql" with { type: "text" };
import queueManage from "./0021_queue_manage.sql" with { type: "text" };
import threadTitles from "./0022_thread_titles.sql" with { type: "text" };
import agentSenders from "./0023_agent_senders.sql" with { type: "text" };
import backgroundTaskNotes from "./0024_background_task_notes.sql" with { type: "text" };
import askUser from "./0025_ask_user.sql" with { type: "text" };
import sidebarThreads from "./0026_sidebar_threads.sql" with { type: "text" };
import schedulesNewThread from "./0027_schedules_new_thread.sql" with { type: "text" };
import archiveCascade from "./0028_archive_cascade.sql" with { type: "text" };
import scheduleEdit from "./0029_schedule_edit.sql" with { type: "text" };
import busNotifyDelivery from "./0030_bus_notify_delivery.sql" with { type: "text" };
import bots from "./0031_bots.sql" with { type: "text" };
import scratchProjects from "./0032_scratch_projects.sql" with { type: "text" };
import botMentions from "./0033_bot_mentions.sql" with { type: "text" };
import botArchive from "./0034_bot_archive.sql" with { type: "text" };
import threadSecrets from "./0036_thread_secrets.sql" with { type: "text" };
import botRoutines from "./0039_bot_routines.sql" with { type: "text" };
import botCreation from "./0040_bot_creation.sql" with { type: "text" };
import connectors from "./0041_connectors.sql" with { type: "text" };
import answerBot from "./0042_answer_bot.sql" with { type: "text" };
import grokProvider from "./0043_grok_provider.sql" with { type: "text" };
import workerEnrollment from "./0044_worker_enrollment.sql" with { type: "text" };
import botHandoffs from "./0045_bot_handoffs.sql" with { type: "text" };
import mobileDevices from "./0046_mobile_devices.sql" with { type: "text" };
import workerSsh from "./0047_worker_ssh.sql" with { type: "text" };
import linkedComputers from "./0048_linked_computers.sql" with { type: "text" };
import threadMirrors from "./0049_thread_mirrors.sql" with { type: "text" };
import sharedConfig from "./0050_shared_config.sql" with { type: "text" };
import linkedAgents from "./0051_linked_agents.sql" with { type: "text" };
import computerRoutes from "./0052_computer_routes.sql" with { type: "text" };
import computerRelay from "./0053_computer_relay.sql" with { type: "text" };
import computerMoves from "./0054_computer_moves.sql" with { type: "text" };
import networkAccess from "./0055_network_access.sql" with { type: "text" };
import mobileNetwork from "./0056_mobile_network.sql" with { type: "text" };
import agentEnvironment from "./0057_agent_environment.sql" with { type: "text" };
import agentSkills from "./0058_agent_skills.sql" with { type: "text" };
import agentSkillSources from "./0059_agent_skill_sources.sql" with { type: "text" };
import agentPlugins from "./0060_agent_plugins.sql" with { type: "text" };
import proxies from "./0061_proxies.sql" with { type: "text" };
import desktopClients from "./0062_desktop_clients.sql" with { type: "text" };
import desktopUpdates from "./0063_desktop_updates.sql" with { type: "text" };
import workerEnrollmentTags from "./0064_worker_enrollment_tags.sql" with { type: "text" };
import instanceConnections from "./0065_instance_connections.sql" with { type: "text" };
import worktrees from "./0066_worktrees.sql" with { type: "text" };
import worktreeLifecycle from "./0067_worktree_lifecycle.sql" with { type: "text" };
import worktreeAutomation from "./0068_worktree_automation.sql" with { type: "text" };
import botErrors from "./0069_bot_errors.sql" with { type: "text" };
import botHarness from "./0070_bot_harness.sql" with { type: "text" };
import botHarnessErrors from "./0071_bot_harness_errors.sql" with { type: "text" };
import workspaceOrigin from "./0072_workspace_origin.sql" with { type: "text" };
import configSync from "./0073_config_sync.sql" with { type: "text" };
import configProviders from "./0074_config_providers.sql" with { type: "text" };
import configProjects from "./0075_config_projects.sql" with { type: "text" };
import configAgentEnvironment from "./0076_config_agent_environment.sql" with { type: "text" };
import configConnectors from "./0077_config_connectors.sql" with { type: "text" };
import configWorkers from "./0078_config_workers.sql" with { type: "text" };
import connectorErrors from "./0079_connector_errors.sql" with { type: "text" };
import fullAccessMode from "./0080_full_access_mode.sql" with { type: "text" };
import connectorOAuthCompletion from "./0081_connector_oauth_completion.sql" with { type: "text" };
import computerRouteWithdrawn from "./0082_computer_route_withdrawn.sql" with { type: "text" };
import tailscaleHttps from "./0083_tailscale_https.sql" with { type: "text" };
import botApprovalExpiry from "./0084_bot_approval_expiry.sql" with { type: "text" };
import interactionDeadlines from "./0085_interaction_deadlines.sql" with { type: "text" };
import gitHeads from "./0086_git_heads.sql" with { type: "text" };
import worktreeBranchNames from "./0087_worktree_branch_names.sql" with { type: "text" };
import threadMirrorDelta from "./0088_thread_mirror_delta.sql" with { type: "text" };
import botApprovalRules from "./0089_bot_approval_rules.sql" with { type: "text" };
import botApprovalDefaults from "./0090_bot_approval_defaults.sql" with { type: "text" };
import externalWorktrees from "./0092_external_worktrees.sql" with { type: "text" };
import cliImports from "./0093_cli_imports.sql" with { type: "text" };
import cliImportLibrary from "./0094_cli_import_library.sql" with { type: "text" };
import busMessageConsumption from "./0095_bus_message_consumption.sql" with { type: "text" };
import consumedBusTurns from "./0096_consumed_bus_turns.sql" with { type: "text" };
import mirrorThreadMetadata from "./0097_mirror_thread_metadata.sql" with { type: "text" };
import threadReadMetadata from "./0098_thread_read_metadata.sql" with { type: "text" };
import messageReceipts from "./0099_message_receipts.sql" with { type: "text" };
import { splitStatements } from "./split.ts";
import queueReadIndexes from "./0103_queue_read_indexes.sql" with { type: "text" };
import databaseRetention from "./0104_database_retention.sql" with { type: "text" };
import retentionIndexes from "./0105_retention_indexes.sql" with { type: "text" };
import pollingIndexes from "./0106_polling_indexes.sql" with { type: "text" };
import lifecycleReadIndexes from "./0107_lifecycle_read_indexes.sql" with { type: "text" };
import secretDeliveryBatches from "./0108_secret_delivery_batches.sql" with { type: "text" };
import secretQueueIndexes from "./0109_secret_queue_indexes.sql" with { type: "text" };
import { indexTasks, runIndexTasks } from "./index-tasks.ts";

/**
 * Runs a .sql file statement by statement (the driver uses the extended protocol only).
 * Migrations stay plain SQL so they can be reviewed and replayed with psql.
 * The migrator wraps each migration in a transaction.
 */
const sqlFile = (content: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    for (const statement of splitStatements(content)) {
      yield* sql.unsafe(statement).raw;
    }
  });

/** Ordered by the numeric prefix. Never edit an applied migration; add a new one (expand/contract). */
export const migrations = Migrator.fromRecord({
  "0001_init": sqlFile(init),
  "0002_worker_config": sqlFile(workerConfig),
  "0003_gateway_runtime": sqlFile(gatewayRuntime),
  "0004_agent_bus_runtime": sqlFile(agentBusRuntime),
  "0005_settings": sqlFile(settings),
  "0006_turn_sources": sqlFile(turnSources),
  "0007_turn_source_details": sqlFile(turnSourceDetails),
  "0008_one_start_per_turn": sqlFile(oneStartPerTurn),
  "0009_models_effort_steer": sqlFile(modelsEffortSteer),
  "0010_goals_background_harness": sqlFile(goalsBackgroundHarness),
  "0011_goals_engine_cleanup": sqlFile(goalsEngineCleanup),
  "0012_worker_restart": sqlFile(workerRestart),
  "0013_turn_end_sources": sqlFile(turnEndSources),
  "0014_turn_permission_mode": sqlFile(turnPermissionMode),
  "0015_provider_profiles": sqlFile(providerProfiles),
  "0016_attachments": sqlFile(attachments),
  "0018_global_providers": sqlFile(globalProviders),
  "0019_thread_reads": sqlFile(threadReads),
  "0020_fork_from_turn": sqlFile(forkFromTurn),
  "0021_queue_manage": sqlFile(queueManage),
  "0022_thread_titles": sqlFile(threadTitles),
  "0023_agent_senders": sqlFile(agentSenders),
  "0024_background_task_notes": sqlFile(backgroundTaskNotes),
  "0025_ask_user": sqlFile(askUser),
  "0026_sidebar_threads": sqlFile(sidebarThreads),
  "0027_schedules_new_thread": sqlFile(schedulesNewThread),
  "0028_archive_cascade": sqlFile(archiveCascade),
  "0029_schedule_edit": sqlFile(scheduleEdit),
  "0030_bus_notify_delivery": sqlFile(busNotifyDelivery),
  "0031_bots": sqlFile(bots),
  "0032_scratch_projects": sqlFile(scratchProjects),
  "0033_bot_mentions": sqlFile(botMentions),
  "0034_bot_archive": sqlFile(botArchive),
  "0036_thread_secrets": sqlFile(threadSecrets),
  "0039_bot_routines": sqlFile(botRoutines),
  "0040_bot_creation": sqlFile(botCreation),
  "0041_connectors": sqlFile(connectors),
  "0042_answer_bot": sqlFile(answerBot),
  "0043_grok_provider": sqlFile(grokProvider),
  "0044_worker_enrollment": sqlFile(workerEnrollment),
  "0045_bot_handoffs": sqlFile(botHandoffs),
  "0046_mobile_devices": sqlFile(mobileDevices),
  "0047_worker_ssh": sqlFile(workerSsh),
  "0048_linked_computers": sqlFile(linkedComputers),
  "0049_thread_mirrors": sqlFile(threadMirrors),
  "0050_shared_config": sqlFile(sharedConfig),
  "0051_linked_agents": sqlFile(linkedAgents),
  "0052_computer_routes": sqlFile(computerRoutes),
  "0053_computer_relay": sqlFile(computerRelay),
  "0054_computer_moves": sqlFile(computerMoves),
  "0055_network_access": sqlFile(networkAccess),
  "0056_mobile_network": sqlFile(mobileNetwork),
  "0057_agent_environment": sqlFile(agentEnvironment),
  "0058_agent_skills": sqlFile(agentSkills),
  "0059_agent_skill_sources": sqlFile(agentSkillSources),
  "0060_agent_plugins": sqlFile(agentPlugins),
  "0061_proxies": sqlFile(proxies),
  "0062_desktop_clients": sqlFile(desktopClients),
  "0063_desktop_updates": sqlFile(desktopUpdates),
  "0064_worker_enrollment_tags": sqlFile(workerEnrollmentTags),
  "0065_instance_connections": sqlFile(instanceConnections),
  "0066_worktrees": sqlFile(worktrees),
  "0067_worktree_lifecycle": sqlFile(worktreeLifecycle),
  "0068_worktree_automation": sqlFile(worktreeAutomation),
  "0069_bot_errors": sqlFile(botErrors),
  "0070_bot_harness": sqlFile(botHarness),
  "0071_bot_harness_errors": sqlFile(botHarnessErrors),
  "0072_workspace_origin": sqlFile(workspaceOrigin),
  "0073_config_sync": sqlFile(configSync),
  "0074_config_providers": sqlFile(configProviders),
  "0075_config_projects": sqlFile(configProjects),
  "0076_config_agent_environment": sqlFile(configAgentEnvironment),
  "0077_config_connectors": sqlFile(configConnectors),
  "0078_config_workers": sqlFile(configWorkers),
  "0079_connector_errors": sqlFile(connectorErrors),
  "0080_full_access_mode": sqlFile(fullAccessMode),
  "0081_connector_oauth_completion": sqlFile(connectorOAuthCompletion),
  "0082_computer_route_withdrawn": sqlFile(computerRouteWithdrawn),
  "0083_tailscale_https": sqlFile(tailscaleHttps),
  "0084_bot_approval_expiry": sqlFile(botApprovalExpiry),
  "0085_interaction_deadlines": sqlFile(interactionDeadlines),
  "0086_git_heads": sqlFile(gitHeads),
  "0087_worktree_branch_names": sqlFile(worktreeBranchNames),
  "0088_thread_mirror_delta": sqlFile(threadMirrorDelta),
  "0089_bot_approval_rules": sqlFile(botApprovalRules),
  "0090_bot_approval_defaults": sqlFile(botApprovalDefaults),
  "0091_bot_view_delta": sqlFile(botViewDelta),
  "0092_external_worktrees": sqlFile(externalWorktrees),
  "0093_cli_imports": sqlFile(cliImports),
  "0094_cli_import_library": sqlFile(cliImportLibrary),
  "0095_bus_message_consumption": sqlFile(busMessageConsumption),
  "0096_consumed_bus_turns": sqlFile(consumedBusTurns),
  "0097_mirror_thread_metadata": sqlFile(mirrorThreadMetadata),
  "0098_thread_read_metadata": sqlFile(threadReadMetadata),
  "0099_message_receipts": sqlFile(messageReceipts),
  "0100_history_read_indexes": sqlFile(historyReadIndexes),
  "0101_composer_turn_choices": sqlFile(composerTurnChoices),
  "0102_bot_composer": sqlFile(botComposer),
  // Performance-only indexes are restartable post-migration tasks, not constraints.
  "0103_queue_read_indexes": Effect.void,
  "0104_database_retention": sqlFile(databaseRetention),
  "0105_retention_indexes": Effect.void,
  "0106_polling_indexes": Effect.void,
  "0107_lifecycle_read_indexes": Effect.void,
  "0108_secret_delivery_batches": sqlFile(secretDeliveryBatches),
  "0109_secret_queue_indexes": Effect.void,
  "0110_config_field_ancestry": sqlFile(configFieldAncestry),
  "0111_worker_event_quarantine": sqlFile(workerEventQuarantine),
  "0112_workspace_copy": sqlFile(workspaceCopy),
  "0113_github_accounts": sqlFile(githubAccounts),
  "0114_github_pull_requests": sqlFile(githubPullRequests),
  "0115_github_detection": sqlFile(githubDetection),
  "0116_github_full_read": sqlFile(githubFullRead),
  "0117_github_mutations": sqlFile(githubMutations),
  "0118_github_reviews": sqlFile(githubReviews),
  "0119_github_lifecycle": sqlFile(githubLifecycle),
  "0120_thread_ranges": sqlFile(threadRanges),
  "0121_thread_publication_failures": sqlFile(threadPublicationFailures),
  "0122_thread_client_cursors": sqlFile(threadClientCursors),
  "0123_thread_sync_diagnostics": sqlFile(threadSyncDiagnostics),
  "0124_thread_range_lock_order": sqlFile(threadRangeLockOrder),
  "0125_inherited_access_mode": sqlFile(inheritedAccessMode),
});

/** Applies pending migrations in a transaction with a lock, safe to call from a deploy step. */
const migrateSchema = Migrator.make({})({ loader: migrations, table: "schema_migrations" });

const deferredIndexes = indexTasks(
  queueReadIndexes +
    "\n" +
    retentionIndexes +
    "\n" +
    pollingIndexes +
    "\n" +
    lifecycleReadIndexes +
    "\n" +
    secretQueueIndexes,
).filter((task) => task.name !== "worker_commands_redelivery");

const migrateWithIndexes = (concurrent: boolean) =>
  Effect.gen(function* () {
    const applied = yield* migrateSchema;
    yield* runIndexTasks(deferredIndexes, concurrent, ["worker_commands_open", "worker_commands_redelivery"]);

    return applied;
  });

export const migrate = migrateWithIndexes(false);
export const migrateOnline = migrateWithIndexes(true);
