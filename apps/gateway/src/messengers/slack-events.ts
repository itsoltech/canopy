import { Match, Option, Schema } from "effect";
import { slackFileId } from "./slack-files.ts";

export const MAX_SLACK_MESSAGE_FILES = 100;

const SlackFiles = Schema.Array(Schema.Json);
const SlackFileRef = Schema.Struct({ id: Schema.String });

export function boundedSlackFileIds(values: readonly string[]): string[] {
  const ids = new Set<string>();

  for (const value of values) {
    if (slackFileId(value)) ids.add(value);

    if (ids.size === MAX_SLACK_MESSAGE_FILES) break;
  }

  return [...ids];
}

function messageFileIds(value: Schema.Json | undefined): string[] {
  const files = Option.getOrElse(Schema.decodeUnknownOption(SlackFiles)(value), () => []);

  const ids = files.flatMap((file) => {
    const reference = Option.getOrUndefined(Schema.decodeUnknownOption(SlackFileRef)(file));

    return reference ? [reference.id] : [];
  });

  return boundedSlackFileIds(ids);
}

const Message = Schema.Struct({
  type: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  app_id: Schema.optional(Schema.String),
  bot_profile: Schema.optional(Schema.JsonObject),
  text: Schema.optional(Schema.String),
  ts: Schema.optional(Schema.String),
  thread_ts: Schema.optional(Schema.String),
  files: Schema.optional(Schema.Json),
});

const Event = Schema.Struct({
  ...Message.fields,
  channel: Schema.optional(Schema.String),
  channel_type: Schema.optional(Schema.String),
  event_ts: Schema.optional(Schema.String),
  deleted_ts: Schema.optional(Schema.String),
  message: Schema.optional(Message),
  previous_message: Schema.optional(Message),
});

export const SlackEnvelope = Schema.Struct({
  type: Schema.String,
  envelope_id: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  connection_info: Schema.optional(Schema.Struct({ app_id: Schema.optional(Schema.String) })),
  payload: Schema.optional(
    Schema.Struct({
      type: Schema.optional(Schema.String),
      event_id: Schema.optional(Schema.String),
      team_id: Schema.optional(Schema.String),
      api_app_id: Schema.optional(Schema.String),
      event: Schema.optional(Event),
    }),
  ),
});

export interface SlackEvent {
  id: string;
  accountId: string;
  channelId: string;
  threadId: string;
  messageId: string;
  authorId: string;
  text: string;
  fileIds?: readonly string[];
  timestamp: string;
  mention: boolean;
  direct: boolean;
  kind: "message" | "edit" | "delete";
}

export interface SlackIdentity {
  externalId: string;
  botUserId: string;
  teamId: string;
  appId: string;
}

const systemSubtypes = new Set([
  "message_replied",
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
]);

export function slackEvent(
  envelope: typeof SlackEnvelope.Type,
  accountId: string,
  identity: SlackIdentity,
): SlackEvent | null {
  const payload = envelope.payload;
  const event = payload?.event;

  if (envelope.type !== "events_api" || payload?.type !== "event_callback" || !payload.event_id || !event?.channel)
    return null;

  if (event.type !== "message" && event.type !== "app_mention") return null;

  const kind = Match.value(event.subtype).pipe(
    Match.when("message_changed", () => "edit" as const),
    Match.when("message_deleted", () => "delete" as const),
    Match.orElse(() => "message" as const),
  );

  const message = Match.value(kind).pipe(
    Match.when("edit", () => event.message),
    Match.when("delete", () => event.previous_message),
    Match.orElse(() => event),
  );

  if (!message && kind !== "delete") return null;
  const authorId = message?.user ?? event.user ?? "";

  if (
    event.bot_id ||
    event.app_id ||
    message?.bot_id ||
    message?.app_id ||
    message?.bot_profile ||
    authorId === identity.botUserId ||
    message?.subtype === "bot_message" ||
    systemSubtypes.has(event.subtype ?? "")
  )
    return null;
  const messageId = kind === "delete" ? (event.deleted_ts ?? message?.ts) : message?.ts;

  if (!messageId || !/^\d+\.\d+$/.test(messageId)) return null;
  const text = message?.text ?? "";
  const fileIds = kind === "delete" ? [] : messageFileIds(message?.files);

  return {
    id: payload.event_id,
    accountId,
    channelId: event.channel,
    threadId: message?.thread_ts ?? "",
    messageId,
    authorId,
    text,
    ...(fileIds.length && { fileIds }),
    timestamp: event.event_ts ?? event.ts ?? messageId,
    mention: event.type === "app_mention" || text.includes(`<@${identity.botUserId}>`),
    direct: event.channel.startsWith("D") || event.channel_type === "im",
    kind,
  };
}
