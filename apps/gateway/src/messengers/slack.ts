import { createHash } from "node:crypto";
import { slackTimestamp, type SlackEvent, type SlackIdentity } from "./slack-events.ts";
import { escapeSlackText, formatSlackMessage } from "./slack-format.ts";
import {
  checkSlackCredentials,
  SlackMessengerError,
  slackRequest,
  slackSocketUrl,
  type SlackCredentials,
  type SlackTransport,
} from "./slack-http.ts";
import { slackSocket } from "./slack-socket.ts";
import { runWithReconnect, sendInOrder, type MessengerAdapter } from "./provider.ts";
import { downloadSlackFile } from "./slack-files.ts";
import { shareSlackFiles, uploadSlackFiles } from "./slack-uploads.ts";
import type { MessengerIngestOutcome } from "./types.ts";

export { SlackMessengerError } from "./slack-http.ts";

export { slackMessengerAppManifest, slackMessengerAppCreateUrl } from "./slack-app.ts";

export type { SlackCredentials, SlackTransport } from "./slack-http.ts";

export type { SlackEvent } from "./slack-events.ts";

export interface SlackMessengerOptions {
  accountId: string;
  credentials: SlackCredentials;
  botUserId: string;
  onEvent: (event: SlackEvent) => Promise<readonly MessengerIngestOutcome[] | void>;
  onStatus?: (status: "connecting" | "connected" | "retrying") => Promise<void>;
  log?: (message: string) => void;
  transport?: SlackTransport;
}

export interface SlackOutboundMessage {
  id: string;
  channelId: string;
  threadId?: string;
  text: string;
}

const maxSlackMessageLength = 40_000;

async function slackIdentity(
  credentials: SlackCredentials,
  signal?: AbortSignal,
  transport?: SlackTransport,
): Promise<SlackIdentity> {
  checkSlackCredentials(credentials);
  const auth = await slackRequest("auth.test", credentials.botToken, new URLSearchParams(), signal, transport);

  if (!auth.bot_id || !auth.team_id || !auth.user_id)
    throw new SlackMessengerError("configuration", "bot_identity_missing");

  const info = await slackRequest(
    "bots.info",
    credentials.botToken,
    new URLSearchParams({ bot: auth.bot_id }),
    signal,
    transport,
  );

  if (!info.bot?.app_id) throw new SlackMessengerError("configuration", "app_identity_missing");

  return {
    externalId: `${auth.team_id}:${auth.bot_id}`,
    botUserId: auth.user_id,
    teamId: auth.team_id,
    appId: info.bot.app_id,
  };
}

/** Verifies both tokens and the Socket Mode app pairing without storing credentials. */
export async function validateSlackAccount(
  credentials: SlackCredentials,
  signal?: AbortSignal,
  transport?: SlackTransport,
) {
  const identity = await slackIdentity(credentials, signal, transport);
  const url = await slackSocketUrl(credentials, signal, transport);
  const timeout = AbortSignal.timeout(20_000);
  const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  await slackSocket({
    url,
    identity,
    accountId: "",
    signal: probeSignal,
    onEvent: async () => {},
    probe: true,
    ...(transport && { transport }),
  });
  probeSignal.throwIfAborted();

  return {
    externalId: identity.externalId,
    botUserId: identity.botUserId,
    teamId: identity.teamId,
    appId: identity.appId,
  };
}

function clientMessageId(id: string) {
  if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) return id.toLowerCase();
  const hash = createHash("sha256").update(`canopy:slack:${id}`).digest("hex");

  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export class SlackMessenger {
  constructor(private readonly options: SlackMessengerOptions) {}

  /** Lifecycle belongs to the account lease holder; abort closes the socket and cancels backoff. */
  async run(signal: AbortSignal): Promise<void> {
    let identity: SlackIdentity | undefined;

    await runWithReconnect(signal, {
      onStatus: this.options.onStatus,
      transport: this.options.transport,
      connect: async () => {
        identity ??= await slackIdentity(this.options.credentials, signal, this.options.transport);

        if (identity.botUserId !== this.options.botUserId)
          throw new SlackMessengerError("configuration", "bot_identity_mismatch");
        const url = await slackSocketUrl(this.options.credentials, signal, this.options.transport);
        await slackSocket({ ...this.options, identity, url, signal });
      },
    });
  }

  /** Never retries a write. The durable outbox must distinguish rate limits from ambiguous success. */
  send(message: SlackOutboundMessage, signal?: AbortSignal) {
    return postSlackMessage(this.options.credentials, message, signal, this.options.transport);
  }
}

/** Posts as the installed Slack app. The caller is responsible for authorization and deduplication. */
export async function postSlackMessage(
  credentials: SlackCredentials,
  message: SlackOutboundMessage,
  signal?: AbortSignal,
  transport?: SlackTransport,
): Promise<{ messageId: string; channelId: string }> {
  checkSlackCredentials(credentials);

  if (
    !message.id ||
    !/^[CDG][A-Z\d]+$/.test(message.channelId) ||
    (message.threadId && !/^\d+\.\d+$/.test(message.threadId))
  )
    throw new SlackMessengerError("configuration", "invalid_message_target");
  const literal = escapeSlackText(message.text);

  if (!literal.trim() || Array.from(literal).length > maxSlackMessageLength)
    throw new SlackMessengerError("configuration", "message_size_limit");
  const formatted = formatSlackMessage(message.text);

  const fields = new URLSearchParams({
    channel: message.channelId,
    text: Array.from(formatted.text).length <= maxSlackMessageLength ? formatted.text : literal,
    client_msg_id: clientMessageId(message.id),
    parse: "none",
    mrkdwn: "false",
    link_names: "false",
    unfurl_links: "false",
    unfurl_media: "false",
  });

  if (formatted.blocks.length) fields.set("blocks", JSON.stringify(formatted.blocks));

  if (message.threadId) fields.set("thread_ts", message.threadId);

  const result = await slackRequest("chat.postMessage", credentials.botToken, fields, signal, transport);

  if (!result.ts || !result.channel) throw new SlackMessengerError("unknown_write", "invalid_send_response");

  return { messageId: result.ts, channelId: result.channel };
}

export const slackAdapter: MessengerAdapter = {
  provider: "slack",
  channelId: /^[CG][A-Z0-9]{1,79}$/,
  userId: /^[UW][A-Z0-9]{1,79}$/,
  channelContext: true,
  maxFileBytes: 50 * 1024 ** 2,
  fileReference: /^F[A-Z0-9]{1,31}$/,
  download: (credentials, fileId, maxBytes, signal, transport) =>
    downloadSlackFile({ fileId, token: credentials.botToken, maxBytes, signal, ...(transport && { transport }) }),
  validate: validateSlackAccount,
  run: (options, signal) => new SlackMessenger(options).run(signal),
  send: async (credentials, message, signal, transport) => {
    const files = message.files ?? [];

    if (!message.text.trim() && !files.length) throw new SlackMessengerError("configuration", "message_size_limit");
    const uploaded = files.length ? await uploadSlackFiles(credentials, files, signal, transport) : [];

    const messageId = await sendInOrder(
      [
        ...(message.text.trim()
          ? [
              async () => {
                const confirmed = await postSlackMessage(credentials, message, signal, transport);

                if (confirmed.channelId !== message.channelId || !slackTimestamp.test(confirmed.messageId))
                  throw new SlackMessengerError("unknown_write", "invalid_send_response");

                return confirmed.messageId;
              },
            ]
          : []),
        ...(uploaded.length
          ? [() => shareSlackFiles(credentials, uploaded, message.channelId, message.threadId, signal, transport)]
          : []),
      ],
      () => new SlackMessengerError("unknown_write", "partial_send"),
    );

    return { channelId: message.channelId, messageId };
  },
};
