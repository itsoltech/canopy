import { SlackMessengerError, slackRequest, type SlackTransport } from "./slack-http.ts";

/** Lists only channels the installed bot has joined and can receive messages from. */
export async function slackChannels(token: string, name: string, cursor: string, transport?: SlackTransport) {
  const result = await slackRequest(
    "conversations.list",
    token,
    new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
      cursor,
    }),
    undefined,
    transport,
  );

  if (!result.channels) throw new SlackMessengerError("retryable", "invalid_channel_response");
  const query = name.trim().replace(/^#/, "").toLowerCase();

  return {
    channels: result.channels
      .filter((channel) => channel.is_member && !channel.is_archived && channel.name.toLowerCase().includes(query))
      .map((channel) => ({ id: channel.id, name: channel.name, private: channel.is_private })),
    next_cursor: result.response_metadata?.next_cursor ?? "",
  };
}
