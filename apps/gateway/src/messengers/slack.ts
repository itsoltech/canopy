import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { SlackEvent, SlackIdentity } from "./slack-events.ts";
import {
  checkSlackCredentials,
  SlackMessengerError,
  slackRequest,
  slackSocketUrl,
  type SlackCredentials,
  type SlackTransport,
} from "./slack-http.ts";
import { slackSocket } from "./slack-socket.ts";

export { SlackMessengerError } from "./slack-http.ts";

export { slackMessengerAppManifest, slackMessengerAppCreateUrl } from "./slack-app.ts";

export type { SlackCredentials, SlackTransport } from "./slack-http.ts";

export type { SlackEvent } from "./slack-events.ts";

export interface SlackMessengerOptions {
  accountId: string;
  credentials: SlackCredentials;
  botUserId: string;
  onEvent: (event: SlackEvent) => Promise<void>;
  onStatus?: (status: "connecting" | "connected" | "retrying") => Promise<void>;
  transport?: SlackTransport;
}

export interface SlackOutboundMessage {
  id: string;
  channelId: string;
  threadId?: string;
  text: string;
}

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

  return { externalId: identity.externalId, botUserId: identity.botUserId, teamId: identity.teamId };
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
    let failures = 0;

    while (!signal.aborted) {
      await this.options.onStatus?.("connecting");
      let retryAfterMs = 0;
      const started = Date.now();

      try {
        identity ??= await slackIdentity(this.options.credentials, signal, this.options.transport);

        if (identity.botUserId !== this.options.botUserId)
          throw new SlackMessengerError("configuration", "bot_identity_mismatch");
        const url = await slackSocketUrl(this.options.credentials, signal, this.options.transport);
        await slackSocket({ ...this.options, identity, url, signal });
      } catch (error) {
        if (signal.aborted) return;

        if (error instanceof SlackMessengerError) {
          if (error.kind === "configuration") throw error;
          retryAfterMs = error.retryAfterMs ?? 0;
        }
      }

      if (signal.aborted) return;

      await this.options.onStatus?.("retrying");

      if (Date.now() - started > 30_000) failures = 0;
      const baseDelay = this.options.transport?.reconnectDelayMs ?? 1000;
      const backoff = Math.min(30_000, baseDelay * 2 ** Math.min(failures++, 8));

      try {
        await delay(Math.max(retryAfterMs, backoff + Math.random() * backoff * 0.2), undefined, { signal });
      } catch {
        return;
      }
    }
  }

  /** Never retries a write. The durable outbox must distinguish rate limits from ambiguous success. */
  async send(message: SlackOutboundMessage, signal?: AbortSignal): Promise<{ messageId: string; channelId: string }> {
    checkSlackCredentials(this.options.credentials);

    if (
      !message.id ||
      !/^[CDG][A-Z\d]+$/.test(message.channelId) ||
      (message.threadId && !/^\d+\.\d+$/.test(message.threadId))
    )
      throw new SlackMessengerError("configuration", "invalid_message_target");
    const text = message.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

    if (!text.trim() || Array.from(text).length > 40_000 || Buffer.byteLength(text) > 160_000)
      throw new SlackMessengerError("configuration", "message_size_limit");

    const fields = new URLSearchParams({
      channel: message.channelId,
      text,
      client_msg_id: clientMessageId(message.id),
      parse: "none",
      mrkdwn: "false",
      link_names: "false",
      unfurl_links: "false",
      unfurl_media: "false",
    });

    if (message.threadId) fields.set("thread_ts", message.threadId);

    const result = await slackRequest(
      "chat.postMessage",
      this.options.credentials.botToken,
      fields,
      signal,
      this.options.transport,
    );

    if (!result.ts || !result.channel) throw new SlackMessengerError("unknown_write", "invalid_send_response");

    return { messageId: result.ts, channelId: result.channel };
  }
}
