import { Option, Schema } from "effect";
import type { MessengerEvent } from "./types.ts";

const User = Schema.Struct({
  id: Schema.Number,
  is_bot: Schema.Boolean,
  username: Schema.optional(Schema.String),
});

const Entity = Schema.Struct({
  type: Schema.String,
  offset: Schema.Number,
  length: Schema.Number,
  user: Schema.optional(Schema.Struct({ id: Schema.Number })),
});

const File = Schema.Struct({ file_id: Schema.String, file_name: Schema.optional(Schema.String) });

const Message = Schema.Struct({
  message_id: Schema.Number,
  from: Schema.optional(User),
  sender_chat: Schema.optional(Schema.Struct({ id: Schema.Number })),
  chat: Schema.Struct({ id: Schema.Number, type: Schema.String }),
  date: Schema.Number,
  edit_date: Schema.optional(Schema.Number),
  text: Schema.optional(Schema.String),
  caption: Schema.optional(Schema.String),
  entities: Schema.optional(Schema.Array(Entity)),
  caption_entities: Schema.optional(Schema.Array(Entity)),
  photo: Schema.optional(Schema.Array(File)),
  document: Schema.optional(File),
  video: Schema.optional(File),
  audio: Schema.optional(File),
  voice: Schema.optional(File),
  animation: Schema.optional(File),
  reply_to_message: Schema.optional(
    Schema.Struct({ message_id: Schema.Number, from: Schema.optional(Schema.Struct({ id: Schema.Number })) }),
  ),
});

export const TelegramUpdate = Schema.Struct({
  update_id: Schema.Number,
  message: Schema.optional(Message),
  edited_message: Schema.optional(Message),
});

export const TelegramUpdates = Schema.Array(Schema.Json);

export const TelegramBot = Schema.Struct({ id: Schema.Number, is_bot: Schema.Boolean, username: Schema.String });

export interface TelegramIdentity {
  id: number;
  username: string;
}

const decodeUpdate = Schema.decodeUnknownOption(TelegramUpdate);

/** A file_id, optionally followed by "/" and the encoded original file name. */
export const telegramFileReference = /^[A-Za-z0-9_-]{10,255}(\/[^\s/]{1,600})?$/;

/** References to the files of a message: the largest photo size and each attached media file. */
function fileReferences(message: typeof Message.Type) {
  const photo = message.photo?.at(-1);

  const named = [message.document, message.video, message.audio, message.animation].filter(
    (file) => file !== undefined,
  );

  return [
    ...(photo ? [photo.file_id] : []),
    ...named.map((file) => (file.file_name ? `${file.file_id}/${encodeURIComponent(file.file_name)}` : file.file_id)),
    ...(message.voice ? [message.voice.file_id] : []),
  ].filter((reference) => telegramFileReference.test(reference));
}

/** Telegram counts entity offsets in UTF-16 code units, which matches JavaScript string indexing. */
function mentions(message: typeof Message.Type, text: string, bot: TelegramIdentity) {
  const entities = message.entities ?? message.caption_entities ?? [];
  const handle = `@${bot.username}`.toLowerCase();

  return entities.some((entity) => {
    const value = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();

    if (entity.type === "mention") return value === handle;

    if (entity.type === "text_mention") return entity.user?.id === bot.id;

    return entity.type === "bot_command" && value.endsWith(handle);
  });
}

/** Maps one update to a messenger event, or explains why it carries no supported message. */
export function telegramEvent(value: Schema.Json, accountId: string, bot: TelegramIdentity) {
  const update = Option.getOrUndefined(decodeUpdate(value));

  if (!update) return { ignored: "invalid_update" } as const;
  const message = update.message ?? update.edited_message;

  if (!message) return { ignored: "unsupported_update" } as const;

  // Channel posts, anonymous admins and other bots have no person to allow.
  if (!message.from || message.from.is_bot || message.sender_chat) return { ignored: "bot_or_channel" } as const;
  const text = message.text ?? message.caption ?? "";

  const fileIds = fileReferences(message);

  if (!text.trim() && !fileIds.length) return { ignored: "unsupported_content" } as const;
  const direct = message.chat.type === "private";
  const reply = message.reply_to_message;
  const edit = update.edited_message !== undefined;

  return {
    id: String(update.update_id),
    accountId,
    channelId: String(message.chat.id),
    threadId: "",
    messageId: String(message.message_id),
    authorId: String(message.from.id),
    text,
    timestamp: String(message.date),
    ...(edit && message.edit_date && { editedTimestamp: String(message.edit_date) }),
    ...(reply && { replyTo: String(reply.message_id) }),
    ...(fileIds.length && { fileIds }),
    mention: !direct && (reply?.from?.id === bot.id || mentions(message, text, bot)),
    direct,
    kind: edit ? "edit" : "message",
  } satisfies MessengerEvent;
}
