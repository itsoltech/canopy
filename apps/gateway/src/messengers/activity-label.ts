import { activityLabel } from "../bots/activity-event.ts";
import { slackChannelId, slackTimestamp } from "./slack-events.ts";

/** Display only account metadata and validated Slack identifiers in the owner's conversation. */
export function slackActivityContext(account: string, channel: string, thread: string) {
  const labels = [activityLabel(account).slice(0, 120)];

  if (slackChannelId.test(channel)) labels.push(`${channel.startsWith("D") ? "DM" : "channel"} ${channel}`);

  if (slackTimestamp.test(thread)) labels.push(`thread ${thread}`);

  return labels.filter(Boolean).join(" · ");
}
