import { Option, Schema } from "effect";
import type { MessengerTransport } from "./provider.ts";
import { telegramError, telegramRequest } from "./telegram-http.ts";
import type { MessengerCredentials, OutboundFile, OutboundMessage } from "./types.ts";

const SentMessage = Schema.Struct({ message_id: Schema.Number, chat: Schema.Struct({ id: Schema.Number }) });

/** Telegram shows these inline as photos; it accepts photos up to 10 MB. */
const photoTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxPhotoBytes = 10 * 1024 ** 2;

/** Sends one file as a photo or document. Returns the provider message ID once Telegram confirmed it. */
export async function sendTelegramFile(
  credentials: MessengerCredentials,
  message: OutboundMessage,
  file: OutboundFile,
  signal: AbortSignal,
  transport: MessengerTransport | undefined,
) {
  const photo = photoTypes.has(file.mimeType) && file.data.byteLength <= maxPhotoBytes;
  const form = new FormData();
  form.set("chat_id", message.channelId);
  form.set(photo ? "photo" : "document", new File([new Uint8Array(file.data)], file.name, { type: file.mimeType }));

  if (message.threadId)
    form.set(
      "reply_parameters",
      JSON.stringify({ message_id: Number(message.threadId), allow_sending_without_reply: true }),
    );

  const sent = await telegramRequest(
    photo ? "sendPhoto" : "sendDocument",
    credentials.botToken,
    form,
    signal,
    transport,
    {
      write: true,
      timeoutMs: 120_000,
    },
  );

  const confirmed = Option.getOrUndefined(Schema.decodeUnknownOption(SentMessage)(sent));

  if (!confirmed || String(confirmed.chat.id) !== message.channelId)
    throw telegramError("unknown_write", "invalid_send_response");

  return String(confirmed.message_id);
}
