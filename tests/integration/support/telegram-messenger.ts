import { Schema } from "effect";
import type { MessengerTransport } from "../../../apps/gateway/src/messengers/provider.ts";

export const telegramToken = "123456:fixture-token-abcdefghijklmnopqrstuvwxyz";

const Body = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));
const Offset = Schema.Struct({ offset: Schema.optional(Schema.Number) });

interface FixtureMessage {
  chat: number;
  from: number;
  text: string;
  chatType?: "private" | "group" | "supergroup";
  replyTo?: { id: number; from: number };
  mention?: boolean;
  edit?: number;
  /** Sends the text as the caption of a document with this name and content. */
  document?: { name: string; content: string };
}

/** Local Telegram Bot API boundary: long-polled updates, confirmed by offset, and recorded writes. */
export function telegramMessengerFixture(options: { webhook?: string } = {}) {
  const updates: { update_id: number }[] = [];
  const sent: Record<string, Schema.Json>[] = [];
  const refusals: ({ status: number; description: string; retryAfter?: number } | undefined)[] = [];
  let confirmed = 0;
  let nextUpdate = 1;
  let nextMessage = 5000;
  let polls = 0;
  const files = new Map<string, string>();
  let wake: (() => void) | undefined;

  const reply = (result: Schema.Json) => Response.json({ ok: true, result });

  async function getUpdates(body: Record<string, Schema.Json>) {
    polls++;
    const offset = Schema.decodeUnknownSync(Offset)(body).offset ?? 0;
    confirmed = Math.max(confirmed, offset);
    const due = () => updates.filter((u) => u.update_id >= offset);

    if (!due().length)
      await Promise.race([
        new Promise<void>((resolve) => (wake = resolve)),
        new Promise((resolve) => setTimeout(resolve, 200)),
      ]);

    return reply(due() as Schema.Json);
  }

  function sendMessage(body: Record<string, Schema.Json>) {
    sent.push(body);
    const refusal = refusals.shift();

    if (refusal)
      return Response.json(
        {
          ok: false,
          error_code: refusal.status,
          description: refusal.description,
          ...(refusal.retryAfter && { parameters: { retry_after: refusal.retryAfter } }),
        },
        { status: refusal.status },
      );

    return reply({ message_id: ++nextMessage, chat: { id: Number(body["chat_id"]) }, date: 1 });
  }

  /** Serves /file/bot<token>/documents/<file_id> as Telegram's file host does. */
  function download(path: string) {
    const [, , token, , fileId = ""] = path.split("/");
    const content = files.get(fileId);

    return token === `bot${telegramToken}` && content !== undefined
      ? new Response(content)
      : new Response(null, { status: 404 });
  }

  /** Records a multipart upload by its fields, file name and size. */
  async function upload(request: Request, method: "sendPhoto" | "sendDocument") {
    const form = await request.formData();
    const file = form.get(method === "sendPhoto" ? "photo" : "document");
    const reply = form.get("reply_parameters");

    return {
      method,
      chat_id: String(form.get("chat_id")),
      file: file instanceof File ? file.name : "",
      bytes: file instanceof File ? file.size : 0,
      ...(reply !== null &&
        !(reply instanceof File) && { reply_parameters: Schema.decodeSync(Schema.fromJsonString(Schema.Json))(reply) }),
    };
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const [, bot, method] = new URL(request.url).pathname.split("/");

      if (bot === "file") return download(new URL(request.url).pathname);

      if (bot !== `bot${telegramToken}`) return Response.json({ ok: false, error_code: 401 }, { status: 401 });

      if (method === "sendPhoto" || method === "sendDocument") return sendMessage(await upload(request, method));
      const body = Schema.decodeSync(Body)(await request.text());

      if (method === "getMe") return reply({ id: 777, is_bot: true, username: "canopy_fixture_bot" });

      if (method === "getWebhookInfo") return reply({ url: options.webhook ?? "" });

      if (method === "getUpdates") return getUpdates(body);

      if (method === "getFile") {
        const fileId = String(body["file_id"]);
        const content = files.get(fileId);

        return content === undefined
          ? Response.json({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, { status: 400 })
          : reply({ file_id: fileId, file_size: content.length, file_path: `documents/${fileId}` });
      }

      if (method === "sendMessage") return sendMessage({ method, ...body });

      return Response.json({ ok: false, error_code: 404 }, { status: 404 });
    },
  });

  const transport: MessengerTransport = {
    telegramApiBaseUrl: `http://127.0.0.1:${server.port}/`,
    reconnectDelayMs: 10,
  };

  return {
    transport,
    sent,
    polls: () => polls,
    acknowledged: (updateId: number) => confirmed > updateId,
    acceptNextSend: () => refusals.push(undefined),
    refuseNextSend: (status: number, description: string, retryAfter?: number) =>
      refusals.push({ status, description, ...(retryAfter && { retryAfter }) }),
    /** Queues a message update and returns its update and message IDs. */
    emit(message: FixtureMessage) {
      const updateId = nextUpdate++;
      const messageId = message.edit ?? ++nextMessage;
      const mention = message.mention ? "@canopy_fixture_bot " : "";
      const text = `${mention}${message.text}`;

      const fileId = `DOC${updateId}fixturefile`;

      if (message.document) files.set(fileId, message.document.content);
      const entities = message.mention && [{ type: "mention", offset: 0, length: mention.length - 1 }];

      const payload = {
        message_id: messageId,
        from: { id: message.from, is_bot: false, first_name: "Fixture" },
        chat: { id: message.chat, type: message.chatType ?? (message.chat > 0 ? "private" : "supergroup") },
        date: 1_700_000_000 + updateId,
        ...(message.document
          ? {
              caption: text,
              document: { file_id: fileId, file_name: message.document.name },
              ...(entities && { caption_entities: entities }),
            }
          : { text, ...(entities && { entities }) }),
        ...(message.edit && { edit_date: 1_700_000_100 + updateId }),
        ...(message.replyTo && {
          reply_to_message: {
            message_id: message.replyTo.id,
            from: { id: message.replyTo.from, is_bot: message.replyTo.from === 777 },
          },
        }),
      };

      updates.push({ update_id: updateId, [message.edit ? "edited_message" : "message"]: payload });
      wake?.();

      return { updateId, messageId };
    },
    close: () => server.stop(true),
  };
}
