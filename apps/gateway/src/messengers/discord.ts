import { createHash } from "node:crypto";
import { Option, Schema } from "effect";
import { DiscordChannels, DiscordUser } from "./discord-events.ts";
import { discordGateway, type DiscordState } from "./discord-gateway.ts";
import { discordError, discordRequest } from "./discord-http.ts";
import { discordForm, discordMessages } from "./discord-files.ts";
import { runWithReconnect, sendInOrder, type MessengerAdapter, type MessengerTransport } from "./provider.ts";
import type { MessengerCredentials, OutboundMessage } from "./types.ts";

const partLength = 1900;

/** Discord's upload limit for bots in servers without boosts, per message. */
const maxFileBytes = 10 * 1024 ** 2;
const snowflake = /^\d{17,20}$/;

const GatewayBot = Schema.Struct({ url: Schema.String.check(Schema.isPattern(/^wss:\/\/[^\s/]+$/)) });
const SentMessage = Schema.Struct({ id: Schema.String, channel_id: Schema.String });

async function botUser(
  credentials: MessengerCredentials,
  signal: AbortSignal | undefined,
  transport?: MessengerTransport,
) {
  const user = Option.getOrUndefined(
    Schema.decodeUnknownOption(DiscordUser)(await discordRequest("users/@me", credentials.botToken, signal, transport)),
  );

  if (!user?.bot) throw discordError("configuration", "bot_identity_missing");

  return user.id;
}

async function gatewayUrl(credentials: MessengerCredentials, signal: AbortSignal, transport?: MessengerTransport) {
  const gateway = Option.getOrUndefined(
    Schema.decodeUnknownOption(GatewayBot)(
      await discordRequest("gateway/bot", credentials.botToken, signal, transport),
    ),
  );

  if (!gateway) throw discordError("retryable", "invalid_gateway_url");

  return gateway.url;
}

/** A nonce lets Discord reject a duplicate of a part it already accepted within a few minutes. */
const nonce = (id: string, part: number) =>
  createHash("sha256").update(`canopy:discord:${id}:${part}`).digest("hex").slice(0, 25);

function target(message: OutboundMessage) {
  const thread = message.threadId.startsWith("thread:") ? message.threadId.slice("thread:".length) : "";
  const reply = thread ? "" : message.threadId;

  if (!snowflake.test(message.channelId) || (thread && !snowflake.test(thread)) || (reply && !snowflake.test(reply)))
    throw discordError("configuration", "invalid_message_target");

  return { channel: thread || message.channelId, reply };
}

export const discordAdapter: MessengerAdapter = {
  provider: "discord",
  channelId: snowflake,
  userId: snowflake,
  channelContext: false,
  maxFileBytes,
  async validate(credentials, signal, transport) {
    const id = await botUser(credentials, signal, transport);
    const timeout = AbortSignal.timeout(20_000);
    const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

    // Connecting once verifies that the privileged Message Content intent is enabled for the bot.
    await discordGateway({
      accountId: "",
      credentials,
      botUserId: id,
      url: await gatewayUrl(credentials, probeSignal, transport),
      channels: new DiscordChannels(),
      state: {},
      signal: probeSignal,
      probe: true,
      onEvent: async () => {},
      ...(transport && { transport }),
    });
    probeSignal.throwIfAborted();

    return { externalId: `discord:${id}`, botUserId: id };
  },
  run(options, signal) {
    const channels = new DiscordChannels();
    const state: DiscordState = {};

    return runWithReconnect(signal, {
      onStatus: options.onStatus,
      transport: options.transport,
      connect: async () => {
        if ((await botUser(options.credentials, signal, options.transport)) !== options.botUserId)
          throw discordError("configuration", "bot_identity_mismatch");
        const url = state.session ? "" : await gatewayUrl(options.credentials, signal, options.transport);
        await discordGateway({ ...options, url, channels, state, signal });
      },
    });
  },
  async send(credentials, message, signal, transport) {
    const { channel, reply } = target(message);
    const messages = discordMessages(message, partLength, maxFileBytes);

    if (!messages.length) throw discordError("configuration", "message_size_limit");

    const messageId = await sendInOrder(
      messages.map((entry, index) => async () => {
        const fields = {
          ...(entry.content && { content: entry.content }),
          nonce: nonce(message.id, index),
          enforce_nonce: true,
          allowed_mentions: { parse: ["users"], replied_user: true },
          ...(reply && index === 0 && { message_reference: { message_id: reply, fail_if_not_exists: false } }),
        };

        const body = entry.files.length ? discordForm(fields, entry.files) : fields;

        const sent = Option.getOrUndefined(
          Schema.decodeUnknownOption(SentMessage)(
            await discordRequest(`channels/${channel}/messages`, credentials.botToken, signal, transport, {
              method: "POST",
              write: true,
              body,
            }),
          ),
        );

        if (!sent || sent.channel_id !== channel) throw discordError("unknown_write", "invalid_send_response");

        return sent.id;
      }),
      () => discordError("unknown_write", "partial_send"),
    );

    return { channelId: message.channelId, messageId };
  },
};
