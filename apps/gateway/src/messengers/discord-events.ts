import { Option, Schema } from "effect";
import type { MessengerEvent } from "./types.ts";

const Snowflake = Schema.String.check(Schema.isPattern(/^\d{1,20}$/));
const Author = Schema.Struct({ id: Snowflake, bot: Schema.optional(Schema.Boolean) });

const Message = Schema.Struct({
  id: Snowflake,
  channel_id: Snowflake,
  guild_id: Schema.optional(Snowflake),
  author: Schema.optional(Author),
  webhook_id: Schema.optional(Schema.String),
  type: Schema.optional(Schema.Number),
  content: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  edited_timestamp: Schema.optional(Schema.NullOr(Schema.String)),
  mentions: Schema.optional(Schema.Array(Schema.Struct({ id: Snowflake }))),
  message_reference: Schema.optional(Schema.Struct({ message_id: Schema.optional(Snowflake) })),
  referenced_message: Schema.optional(Schema.NullOr(Schema.Struct({ author: Schema.optional(Author) }))),
});

const Channel = Schema.Struct({
  id: Snowflake,
  type: Schema.Number,
  parent_id: Schema.optional(Schema.NullOr(Snowflake)),
});

export const DiscordChannel = Channel;

export const GuildCreate = Schema.Struct({
  channels: Schema.optional(Schema.Array(Channel)),
  threads: Schema.optional(Schema.Array(Channel)),
});

export const DiscordUser = Schema.Struct({ id: Snowflake, bot: Schema.optional(Schema.Boolean) });

const decodeMessage = Schema.decodeUnknownOption(Message);

/** Thread channel types: announcement, public and private threads. */
const threadTypes = new Set([10, 11, 12]);

/** Discord threads are channels; routes select their parent, so a thread maps to its parent channel. */
export class DiscordChannels {
  readonly #parents = new Map<string, string>();

  record(channel: typeof Channel.Type) {
    this.#parents.set(channel.id, threadTypes.has(channel.type) && channel.parent_id ? channel.parent_id : "");
  }

  known(id: string) {
    return this.#parents.has(id);
  }

  /** The routed channel and the native thread, if the message was posted in one. */
  location(id: string) {
    const parent = this.#parents.get(id);

    return parent ? { channelId: parent, threadId: `thread:${id}` } : { channelId: id, threadId: "" };
  }
}

export type DiscordDispatch = "MESSAGE_CREATE" | "MESSAGE_UPDATE" | "MESSAGE_DELETE";

/** Maps one message dispatch to a messenger event, or explains why it carries no supported message. */
export function discordEvent(
  type: DiscordDispatch,
  value: Schema.Json,
  accountId: string,
  botUserId: string,
  channels: DiscordChannels,
) {
  const message = Option.getOrUndefined(decodeMessage(value));

  if (!message) return { ignored: "invalid_message" } as const;
  const direct = !message.guild_id;
  const location = direct ? { channelId: message.channel_id, threadId: "" } : channels.location(message.channel_id);
  const base = { accountId, ...location, messageId: message.id, direct };

  if (type === "MESSAGE_DELETE")
    return {
      ...base,
      id: `delete:${message.id}`,
      authorId: "",
      text: "",
      timestamp: "",
      mention: false,
      kind: "delete",
    } satisfies MessengerEvent;

  if (!message.author || message.author.bot || message.webhook_id) return { ignored: "app_or_bot_message" } as const;

  // Default and reply messages carry people's text; joins, pins and other system messages do not.
  if (message.type !== undefined && message.type !== 0 && message.type !== 19)
    return { ignored: "system_message" } as const;

  if (!message.content?.trim()) return { ignored: "unsupported_content" } as const;
  const edited = type === "MESSAGE_UPDATE" ? message.edited_timestamp : undefined;

  if (type === "MESSAGE_UPDATE" && !edited) return { ignored: "not_an_edit" } as const;
  const repliedTo = message.message_reference?.message_id;

  return {
    ...base,
    id: edited ? `edit:${message.id}:${edited}` : `create:${message.id}`,
    authorId: message.author.id,
    text: message.content,
    timestamp: message.timestamp ?? "",
    ...(edited && { editedTimestamp: edited }),
    ...(repliedTo && { replyTo: repliedTo }),
    mention:
      !direct &&
      ((message.mentions ?? []).some((user) => user.id === botUserId) ||
        message.referenced_message?.author?.id === botUserId),
    kind: edited ? "edit" : "message",
  } satisfies MessengerEvent;
}
