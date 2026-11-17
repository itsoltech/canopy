import { Predicate } from "effect";
import { Invalid } from "../store/store.ts";
import { SlackMessengerError, slackRequest, type SlackTransport } from "./slack-http.ts";

export async function slackChannelMembers(token: string, channel: string, cursor: string, transport?: SlackTransport) {
  if (!/^[CG][A-Z0-9]{1,79}$/.test(channel)) throw new Invalid("Choose a valid Slack channel");

  const result = await slackRequest(
    "conversations.members",
    token,
    new URLSearchParams({ channel, cursor, limit: "200" }),
    undefined,
    transport,
  );

  if (!result.members || !result.members.every(Predicate.isString))
    throw new SlackMessengerError("retryable", "invalid_member_response");

  return { user_ids: result.members, next_cursor: result.response_metadata?.next_cursor ?? "" };
}

/** Only public identity fields leave the gateway; emails and other Slack profile data are discarded. */
export async function slackUsers(token: string, name: string, cursor: string, transport?: SlackTransport) {
  const result = await slackRequest(
    "users.list",
    token,
    new URLSearchParams({ cursor, limit: "50" }),
    undefined,
    transport,
  );

  if (!result.members || result.members.some(Predicate.isString))
    throw new SlackMessengerError("retryable", "invalid_user_response");
  const query = name.trim().replace(/^@/, "").toLowerCase();
  const users = result.members.flatMap((user) => (Predicate.isString(user) ? [] : [user]));

  return {
    users: users
      .filter(
        (user) =>
          !user.deleted &&
          !user.is_bot &&
          [user.name, user.real_name, user.profile?.display_name].some((value) => value?.toLowerCase().includes(query)),
      )
      .map((user) => ({
        id: user.id,
        username: user.name ?? "",
        name: user.real_name ?? "",
        display_name: user.profile?.display_name ?? "",
      })),
    next_cursor: result.response_metadata?.next_cursor ?? "",
  };
}
