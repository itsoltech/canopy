import slackChannelContext from "./0220_slack_channel_context.sql" with { type: "text" };
import agentBusUpdateTasks from "./0222_agent_bus_update_tasks.sql" with { type: "text" };
import workerHeartbeatChanges from "./0223_worker_heartbeat_changes.sql" with { type: "text" };
import messengerProviders from "./0224_messenger_providers.sql" with { type: "text" };
import messengerOutboundFiles from "./0225_messenger_outbound_files.sql" with { type: "text" };
import projectLogins from "./0226_project_logins.sql" with { type: "text" };
import threadTransfers from "./0227_thread_transfers.sql" with { type: "text" };
import botParkedInteractions from "./0228_bot_parked_interactions.sql" with { type: "text" };
import botEventTriggers from "./0229_bot_event_triggers.sql" with { type: "text" };
import botTriggerThreadEvents from "./0230_bot_trigger_thread_events.sql" with { type: "text" };
import botTriggerMoreEvents from "./0231_bot_trigger_more_events.sql" with { type: "text" };
import githubAgentAccess from "./0233_github_agent_access.sql" with { type: "text" };
import botSkills from "./0232_bot_skills.sql" with { type: "text" };
import { mobilePushDismissalMigrations } from "./mobile-push.ts";
import threadArtifacts from "./0234_thread_artifacts.sql" with { type: "text" };
import { sqlFile } from "./run.ts";

/** Applied after 0219, in migration order; kept apart so the main map stays within its size limit. */
export const recentMigrations = {
  "0220_slack_channel_context": sqlFile(slackChannelContext),
  ...mobilePushDismissalMigrations,
  "0222_agent_bus_update_tasks": sqlFile(agentBusUpdateTasks),
  "0223_worker_heartbeat_changes": sqlFile(workerHeartbeatChanges),
  "0224_messenger_providers": sqlFile(messengerProviders),
  "0225_messenger_outbound_files": sqlFile(messengerOutboundFiles),
  "0226_project_logins": sqlFile(projectLogins),
  "0227_thread_transfers": sqlFile(threadTransfers),
  "0228_bot_parked_interactions": sqlFile(botParkedInteractions),
  "0229_bot_event_triggers": sqlFile(botEventTriggers),
  "0230_bot_trigger_thread_events": sqlFile(botTriggerThreadEvents),
  "0231_bot_trigger_more_events": sqlFile(botTriggerMoreEvents),
  "0232_bot_skills": sqlFile(botSkills),
  "0233_github_agent_access": sqlFile(githubAgentAccess),
  "0234_thread_artifacts": sqlFile(threadArtifacts),
};
