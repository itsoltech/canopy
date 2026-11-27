import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { messengerAdapter } from "./adapters.ts";
import { MessengerError } from "./messenger-error.ts";
import type { MessengerAdapter, MessengerTransport } from "./provider.ts";
import type { AccountLease, MessengerAccount, MessengerCredentials, OutboundMessage, OutboundResult } from "./types.ts";
import type { MessengerRuntime } from "./runtime.ts";

export const credentialKey = (credentials: MessengerCredentials) =>
  createHash("sha256").update(JSON.stringify(credentials)).digest("hex");

async function sendReply(
  adapter: MessengerAdapter,
  credentials: MessengerCredentials,
  message: OutboundMessage,
  signal: AbortSignal,
  transport: MessengerTransport | undefined,
): Promise<OutboundResult> {
  try {
    return { sent: true, ...(await adapter.send(credentials, message, signal, transport)) };
  } catch (error) {
    const retryable = error instanceof MessengerError && error.kind === "retryable";
    const refused = error instanceof MessengerError && error.kind === "configuration";

    return {
      sent: false,
      uncertain: !retryable && !refused,
      refused,
      ...(retryable && { retryAfterMs: error.retryAfterMs ?? 5000 }),
    };
  }
}

/** One leased incoming connection and its serial outgoing queue. */
export class MessengerAccountSession {
  readonly abort = new AbortController();
  readonly signature: string;
  readonly #task: Promise<void>;
  readonly #adapter: MessengerAdapter;
  readonly #credentials: MessengerCredentials;
  #connected = false;
  #sending: Promise<void> | undefined;
  failed = false;

  constructor(
    readonly runtime: MessengerRuntime,
    readonly account: MessengerAccount,
    readonly lease: AccountLease,
    credentials: MessengerCredentials,
  ) {
    this.signature = credentialKey(credentials);
    this.#adapter = messengerAdapter(account.provider);
    this.#credentials = credentials;
    this.#task = this.#connectWithRetry(credentials).catch(async () => {
      if (!this.abort.signal.aborted) {
        this.failed = true;
        await this.status("needs_reconnect").catch(() => {});
      }
    });
  }

  status(value: string): Promise<void> {
    return this.runtime.run((s) => s.setAccountStatus(this.runtime.owner, this.lease, value));
  }

  async #connectWithRetry(credentials: MessengerCredentials): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        if (!(await this.runtime.enabled())) return;
        await this.#connect(credentials);

        return;
      } catch (error) {
        if (this.abort.signal.aborted) return;

        if (!(error instanceof MessengerError) || error.kind !== "retryable") throw error;
        await this.status("retrying");
        await delay(error.retryAfterMs ?? 5000, undefined, { signal: this.abort.signal });
      }
    }
  }

  async #connect(credentials: MessengerCredentials): Promise<void> {
    await this.status("connecting");
    const { log, messengerTransport } = this.runtime.options;
    const identity = await this.#adapter.validate(credentials, this.abort.signal, messengerTransport);

    if (identity.externalId !== this.account.externalId) throw new Error("Messenger identity changed");
    this.abort.signal.throwIfAborted();
    this.#connected = true;
    const prefix = `messengers: ${this.account.provider} account_id=${this.account.id}`;

    await this.#adapter.run(
      {
        accountId: this.account.id,
        credentials,
        botUserId: identity.botUserId,
        ...(messengerTransport && { transport: messengerTransport }),
        ...(log && { log: (message: string) => log(`${prefix} ${message}`) }),
        onEvent: (event) =>
          this.runtime.run((s) => s.ingest(this.runtime.owner, event, this.lease, this.runtime.now())),
        onStatus: (status) => this.status(status),
      },
      this.abort.signal,
    );
  }

  pump(): void {
    if (!this.#connected || this.#sending || this.abort.signal.aborted || this.failed) return;
    this.#sending = this.#send()
      .catch(() => {})
      .finally(() => {
        this.#sending = undefined;
      });
  }

  async #send(): Promise<void> {
    const rows = await this.runtime.run((s) => s.outbound(this.runtime.owner, this.lease, this.runtime.now()));

    for (const message of rows) {
      const delivery = this.abort.signal.aborted
        ? undefined
        : await this.runtime.run((s) =>
            s.sendClaimed(this.runtime.owner, this.lease, message.id, this.runtime.now(), () =>
              sendReply(
                this.#adapter,
                this.#credentials,
                message,
                this.abort.signal,
                this.runtime.options.messengerTransport,
              ),
            ),
          );

      const result = delivery ? await delivery.completion : { sent: false, retryAfterMs: 1000 };
      await this.runtime.run((s) =>
        s.settleOutbound(this.runtime.owner, this.lease, message.id, result, this.runtime.now()),
      );
    }
  }

  async close(): Promise<void> {
    this.abort.abort();
    await this.#task;
    await this.#sending;
    await this.runtime.run((s) => s.releaseAccount(this.runtime.owner, this.lease));
  }
}
