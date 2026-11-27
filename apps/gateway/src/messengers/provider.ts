import { setTimeout as delay } from "node:timers/promises";
import { MessengerError } from "./messenger-error.ts";
import type { SlackTransport } from "./slack-http.ts";
import type { MessengerCredentials, MessengerEvent, MessengerIngestOutcome, OutboundMessage } from "./types.ts";

export const messengerProviders = ["slack", "telegram", "discord"] as const;

export type MessengerProvider = (typeof messengerProviders)[number];

export function messengerProvider(value: string): MessengerProvider | undefined {
  return messengerProviders.find((provider) => provider === value);
}

const labels: Record<MessengerProvider, string> = { slack: "Slack", telegram: "Telegram", discord: "Discord" };

export const messengerLabel = (provider: MessengerProvider) => labels[provider];

/** Overrides are trusted gateway/test dependencies, never account-controlled URLs. */
export interface MessengerTransport extends SlackTransport {
  telegramApiBaseUrl?: string;
  discordApiBaseUrl?: string;
}

export interface MessengerIdentity {
  externalId: string;
  botUserId: string;
}

export type MessengerStatus = "connecting" | "connected" | "retrying";

export interface MessengerRunOptions {
  accountId: string;
  credentials: MessengerCredentials;
  botUserId: string;
  onEvent: (event: MessengerEvent) => Promise<readonly MessengerIngestOutcome[] | void>;
  onStatus?: (status: MessengerStatus) => Promise<void>;
  log?: (message: string) => void;
  transport?: MessengerTransport;
}

export interface MessengerSendResult {
  channelId: string;
  messageId: string;
}

/** One provider connection: account validation, durable-ack reception and a single non-retried write. */
export interface MessengerAdapter {
  readonly provider: MessengerProvider;
  /** Route channel IDs, excluding direct messages, which routes select as a whole. */
  readonly channelId: RegExp;
  readonly userId: RegExp;
  /** Shared channel background is implemented only where the provider exposes ordered channel history. */
  readonly channelContext: boolean;
  /** Largest file the provider accepts from a bot. */
  readonly maxFileBytes: number;
  validate(
    credentials: MessengerCredentials,
    signal?: AbortSignal,
    transport?: MessengerTransport,
  ): Promise<MessengerIdentity>;
  /** Lifecycle belongs to the account lease holder; abort closes the connection and cancels backoff. */
  run(options: MessengerRunOptions, signal: AbortSignal): Promise<void>;
  /** Never retries a write. Throws MessengerError; a returned result confirms the provider accepted the message. */
  send(
    credentials: MessengerCredentials,
    message: OutboundMessage,
    signal: AbortSignal,
    transport?: MessengerTransport,
  ): Promise<MessengerSendResult>;
}

/** Files one reply may carry, across every provider. */
export const MAX_REPLY_FILES = 10;
export const MAX_REPLY_BYTES = 50 * 1024 ** 2;

/** Reconnects a provider stream with jittered backoff until a configuration failure or abort. */
export async function runWithReconnect(
  signal: AbortSignal,
  options: {
    onStatus?: ((status: MessengerStatus) => Promise<void>) | undefined;
    transport?: MessengerTransport | undefined;
    connect: () => Promise<void>;
  },
): Promise<void> {
  let failures = 0;

  while (!signal.aborted) {
    await options.onStatus?.("connecting");
    let retryAfterMs = 0;
    const started = Date.now();

    try {
      await options.connect();
    } catch (error) {
      if (signal.aborted) return;

      if (error instanceof MessengerError) {
        if (error.kind === "configuration") throw error;
        retryAfterMs = error.retryAfterMs ?? 0;
      }
    }

    if (signal.aborted) return;

    await options.onStatus?.("retrying");

    if (Date.now() - started > 30_000) failures = 0;
    const baseDelay = options.transport?.reconnectDelayMs ?? 1000;
    const backoff = Math.min(30_000, baseDelay * 2 ** Math.min(failures++, 8));
    const milliseconds = Math.max(retryAfterMs, backoff + Math.random() * backoff * 0.2);
    const wait = options.transport?.waitForReconnect;

    try {
      await (wait ? wait(milliseconds, signal) : delay(milliseconds, undefined, { signal }));
    } catch {
      return;
    }
  }
}

/** Splits text at line or word boundaries into provider-sized parts, counted in code points. */
export function splitMessage(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = Array.from(text.trim());

  while (rest.length > limit) {
    const window = rest.slice(0, limit).join("");
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const size = cut > limit / 2 ? Array.from(window.slice(0, cut)).length : limit;
    parts.push(rest.slice(0, size).join("").trimEnd());
    rest = Array.from(rest.slice(size).join("").trimStart());
  }

  if (rest.length) parts.push(rest.join(""));

  return parts;
}

/** Runs a reply's visible writes in order and returns the last message ID a write reported. Once one write succeeded, a later
 * failure leaves the reply partially delivered, so it is reported as an unknown outcome instead of a retry. */
export async function sendInOrder(
  writes: readonly (() => Promise<string>)[],
  partial: () => MessengerError,
): Promise<string> {
  let messageId = "";

  for (const [index, write] of writes.entries()) {
    try {
      messageId = (await write()) || messageId;
    } catch (error) {
      if (index > 0) throw partial();

      throw error;
    }
  }

  return messageId;
}
