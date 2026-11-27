import { Option, Schema } from "effect";
import { MessengerError } from "./messenger-error.ts";
import { runWithReconnect, splitMessage, type MessengerAdapter, type MessengerRunOptions } from "./provider.ts";
import { TelegramBot, TelegramUpdates, telegramEvent, type TelegramIdentity } from "./telegram-events.ts";
import { formatTelegramMessage } from "./telegram-format.ts";
import { telegramError, telegramRequest, type TelegramBody } from "./telegram-http.ts";
import type { MessengerCredentials, OutboundMessage } from "./types.ts";

/** Telegram's limit is 4096 characters after entity parsing; Markdown parts stay well below it. */
const partLength = 3500;
const pollSeconds = 25;

const SentMessage = Schema.Struct({ message_id: Schema.Number, chat: Schema.Struct({ id: Schema.Number }) });
const WebhookInfo = Schema.Struct({ url: Schema.String });

async function telegramIdentity(
  credentials: MessengerCredentials,
  signal: AbortSignal | undefined,
  transport: MessengerRunOptions["transport"],
): Promise<TelegramIdentity> {
  const bot = Option.getOrUndefined(
    Schema.decodeUnknownOption(TelegramBot)(
      await telegramRequest("getMe", credentials.botToken, {}, signal, transport),
    ),
  );

  if (!bot?.is_bot) throw telegramError("configuration", "bot_identity_missing");

  return { id: bot.id, username: bot.username };
}

/** Polls getUpdates and advances the offset only after the gateway durably accepted each update. */
async function poll(options: MessengerRunOptions, bot: TelegramIdentity, signal: AbortSignal) {
  let offset: number | undefined;
  let connected = false;

  for (;;) {
    const result = await telegramRequest(
      "getUpdates",
      options.credentials.botToken,
      { ...(offset !== undefined && { offset }), timeout: pollSeconds, allowed_updates: ["message", "edited_message"] },
      signal,
      options.transport,
      { timeoutMs: (pollSeconds + 15) * 1000 },
    );

    if (!connected) {
      connected = true;
      await options.onStatus?.("connected");
    }

    const updates = Option.getOrElse(Schema.decodeUnknownOption(TelegramUpdates)(result), () => []);

    for (const update of updates) {
      const event = telegramEvent(update, options.accountId, bot);

      if ("ignored" in event) options.log?.(`update ignored reason=${event.ignored}`);
      else await options.onEvent(event);
      const id = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Struct({ update_id: Schema.Number }))(update));

      if (id) offset = id.update_id + 1;
    }
  }
}

async function sendPart(
  credentials: MessengerCredentials,
  message: OutboundMessage,
  text: string,
  signal: AbortSignal,
  transport: MessengerRunOptions["transport"],
) {
  const target = {
    chat_id: message.channelId,
    link_preview_options: { is_disabled: true },
    ...(message.threadId && {
      reply_parameters: { message_id: Number(message.threadId), allow_sending_without_reply: true },
    }),
  };

  const request = (body: TelegramBody) =>
    telegramRequest("sendMessage", credentials.botToken, { ...target, ...body }, signal, transport, { write: true });

  let sent: Schema.Json;

  try {
    sent = await request({ text: formatTelegramMessage(text), parse_mode: "HTML" });
  } catch (error) {
    // Telegram refused the formatted message, so it was not sent and plain text cannot duplicate it.
    if (!(error instanceof MessengerError) || error.code !== "entities") throw error;
    sent = await request({ text });
  }

  const confirmed = Option.getOrUndefined(Schema.decodeUnknownOption(SentMessage)(sent));

  if (!confirmed || String(confirmed.chat.id) !== message.channelId)
    throw telegramError("unknown_write", "invalid_send_response");

  return String(confirmed.message_id);
}

export const telegramAdapter: MessengerAdapter = {
  provider: "telegram",
  // Group and supergroup chat IDs are negative. Private chats are selected as direct messages.
  channelId: /^-\d{1,20}$/,
  userId: /^\d{1,20}$/,
  channelContext: false,
  async validate(credentials, signal, transport) {
    const bot = await telegramIdentity(credentials, signal, transport);

    const webhook = Option.getOrUndefined(
      Schema.decodeUnknownOption(WebhookInfo)(
        await telegramRequest("getWebhookInfo", credentials.botToken, {}, signal, transport),
      ),
    );

    // getUpdates is unavailable while a webhook is set; removing someone else's webhook is not ours to do.
    if (webhook?.url) throw telegramError("configuration", "webhook_active");

    return { externalId: `telegram:${bot.id}`, botUserId: String(bot.id) };
  },
  run: (options, signal) =>
    runWithReconnect(signal, {
      onStatus: options.onStatus,
      transport: options.transport,
      connect: async () => {
        const bot = await telegramIdentity(options.credentials, signal, options.transport);

        if (String(bot.id) !== options.botUserId) throw telegramError("configuration", "bot_identity_mismatch");
        await poll(options, bot, signal);
      },
    }),
  async send(credentials, message, signal, transport) {
    const parts = splitMessage(message.text, partLength);

    if (
      !parts.length ||
      !/^-?\d{1,20}$/.test(message.channelId) ||
      (message.threadId && !/^\d{1,20}$/.test(message.threadId))
    )
      throw telegramError("configuration", "invalid_message_target");
    let messageId = "";

    for (const [index, part] of parts.entries()) {
      try {
        messageId = await sendPart(credentials, message, part, signal, transport);
      } catch (error) {
        // Earlier parts are already visible: any later failure leaves the reply partially delivered.
        if (index > 0) throw telegramError("unknown_write", "partial_send");

        throw error;
      }
    }

    return { channelId: message.channelId, messageId };
  },
};
