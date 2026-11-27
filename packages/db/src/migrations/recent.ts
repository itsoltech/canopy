import slackChannelContext from "./0220_slack_channel_context.sql" with { type: "text" };
import agentBusUpdateTasks from "./0222_agent_bus_update_tasks.sql" with { type: "text" };
import { mobilePushDismissalMigrations } from "./mobile-push.ts";
import { sqlFile } from "./run.ts";

/** Applied after 0219, in migration order; kept apart so the main map stays within its size limit. */
export const recentMigrations = {
  "0220_slack_channel_context": sqlFile(slackChannelContext),
  ...mobilePushDismissalMigrations,
  "0222_agent_bus_update_tasks": sqlFile(agentBusUpdateTasks),
};
