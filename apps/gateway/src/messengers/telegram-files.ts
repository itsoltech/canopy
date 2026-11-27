import { safeFileName } from "@canopy/domain";
import { Option, Schema } from "effect";
import { readSlackBody as readLimitedBody } from "./slack-http.ts";
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

const RemoteFile = Schema.Struct({ file_path: Schema.String, file_size: Schema.optional(Schema.Number) });

/** The Bot API serves files a bot receives up to 20 MB. */
const maxDownloadBytes = 20 * 1024 ** 2;

/** Downloads a file a participant sent. The token is part of the file URL, which is never logged. */
export async function downloadTelegramFile(
  credentials: MessengerCredentials,
  reference: string,
  maxBytes: number,
  signal: AbortSignal,
  transport: MessengerTransport | undefined,
) {
  const [fileId = "", encodedName] = reference.split("/");
  const limit = Math.min(maxBytes, maxDownloadBytes);

  const remote = Option.getOrUndefined(
    Schema.decodeUnknownOption(RemoteFile)(
      await telegramRequest("getFile", credentials.botToken, { file_id: fileId }, signal, transport),
    ),
  );

  if (!remote || (remote.file_size ?? 0) > limit || remote.file_path.includes(".."))
    throw telegramError("configuration", "file_too_large");
  let response: Response;

  try {
    response = await (transport?.fetch ?? fetch)(
      new URL(
        `./file/bot${credentials.botToken}/${remote.file_path}`,
        transport?.telegramApiBaseUrl ?? "https://api.telegram.org/",
      ),
      { redirect: "error", credentials: "omit", signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) },
    );
  } catch {
    throw telegramError("retryable", "file_unavailable");
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});

    throw telegramError("retryable", "file_unavailable");
  }

  const data = await readLimitedBody(response, limit);

  if (!data) throw telegramError("configuration", "file_too_large");
  const name = encodedName ? decodeURIComponent(encodedName) : (remote.file_path.split("/").at(-1) ?? fileId);

  return { name: safeFileName(name), data };
}
