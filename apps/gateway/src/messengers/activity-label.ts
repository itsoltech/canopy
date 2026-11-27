import { activityLabel } from "../bots/activity-event.ts";

const identifier = /^-?[A-Za-z0-9][\w.:-]{0,99}$/;

/** Display only account metadata and validated provider identifiers in the owner's conversation. */
export function messengerActivityContext(account: string, channel: string, thread: string, direct: boolean) {
  const labels = [activityLabel(account).slice(0, 120)];

  if (identifier.test(channel)) labels.push(`${direct ? "DM" : "channel"} ${channel}`);

  if (identifier.test(thread)) labels.push(`thread ${thread}`);

  return labels.filter(Boolean).join(" · ");
}
