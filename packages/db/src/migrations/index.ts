// oxlint-disable-next-line typescript/triple-slash-reference -- gateway and integration tests typecheck this file under their own tsconfig; only a reference carries the ambient "*.sql" module declaration with it.
/// <reference path="../sql-modules.d.ts" />
import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import init from "./0001_init.sql" with { type: "text" };
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
import { splitStatements } from "./split.ts";

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
});

/** Applies pending migrations in a transaction with a lock, safe to call from a deploy step. */
export const migrate = Migrator.make({})({ loader: migrations, table: "schema_migrations" });
