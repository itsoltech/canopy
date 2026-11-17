import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { SlackMessenger, SlackMessengerError, validateSlackAccount } from "./slack.ts";
import type { AccountLease, MessengerAccount, MessengerCredentials } from "./types.ts";
import type { MessengerRuntime } from "./runtime.ts";

export const credentialKey = (credentials: MessengerCredentials) =>
  createHash("sha256").update(JSON.stringify(credentials)).digest("hex");

/** One leased incoming connection and its serial outgoing queue. */
export class MessengerAccountSession {
  readonly abort = new AbortController();
  readonly signature: string;
  readonly #task: Promise<void>;
  #adapter: SlackMessenger | undefined;
  #sending: Promise<void> | undefined;
  failed = false;

  constructor(
    readonly runtime: MessengerRuntime,
    readonly account: MessengerAccount,
    readonly lease: AccountLease,
    credentials: MessengerCredentials,
  ) {
    this.signature = credentialKey(credentials);
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
        await this.#connect(credentials);

        return;
      } catch (error) {
        if (this.abort.signal.aborted) return;

        if (!(error instanceof SlackMessengerError) || error.kind !== "retryable") throw error;
        await this.status("retrying");
        await delay(error.retryAfterMs ?? 5000, undefined, { signal: this.abort.signal });
      }
    }
  }

  async #connect(credentials: MessengerCredentials): Promise<void> {
    await this.status("connecting");

    const identity = await validateSlackAccount(
      credentials,
      this.abort.signal,
      this.runtime.options.messengerTransport,
    );

    if (identity.externalId !== this.account.externalId) throw new Error("Messenger identity changed");
    this.abort.signal.throwIfAborted();
    this.#adapter = new SlackMessenger({
      accountId: this.account.id,
      credentials,
      botUserId: identity.botUserId,
      ...(this.runtime.options.messengerTransport && { transport: this.runtime.options.messengerTransport }),
      onEvent: async (event) => {
        await this.runtime.run((s) => s.ingest(this.runtime.owner, event, this.lease, this.runtime.now()));
      },
      onStatus: (status) => this.status(status),
    });
    await this.#adapter.run(this.abort.signal);
  }

  pump(): void {
    if (!this.#adapter || this.#sending || this.abort.signal.aborted || this.failed) return;
    this.#sending = this.#send()
      .catch(() => {})
      .finally(() => {
        this.#sending = undefined;
      });
  }

  async #send(): Promise<void> {
    const adapter = this.#adapter;

    if (!adapter) return;
    const rows = await this.runtime.run((s) => s.outbound(this.runtime.owner, this.lease, this.runtime.now()));

    for (const message of rows) {
      if (this.abort.signal.aborted) {
        await this.runtime.run((s) =>
          s.settleOutbound(
            this.runtime.owner,
            this.lease,
            message.id,
            { sent: false, retryAfterMs: 1000 },
            this.runtime.now(),
          ),
        );
        continue;
      }

      try {
        await adapter.send(message, this.abort.signal);
        await this.runtime.run((s) =>
          s.settleOutbound(this.runtime.owner, this.lease, message.id, { sent: true }, this.runtime.now()),
        );
      } catch (error) {
        const retryable = error instanceof SlackMessengerError && error.kind === "retryable";
        const refused = error instanceof SlackMessengerError && error.kind === "configuration";
        await this.runtime.run((s) =>
          s.settleOutbound(
            this.runtime.owner,
            this.lease,
            message.id,
            {
              sent: false,
              uncertain: !retryable && !refused,
              refused,
              ...(retryable && { retryAfterMs: error.retryAfterMs ?? 5000 }),
            },
            this.runtime.now(),
          ),
        );

        // A refused message can be specific to its size or channel. Connection/authentication
        // failures are handled by the receiving lifecycle, without disabling other routes here.
      }
    }
  }

  async close(): Promise<void> {
    this.abort.abort();
    await this.#task;
    await this.#sending;
    await this.runtime.run((s) => s.releaseAccount(this.runtime.owner, this.lease));
  }
}
