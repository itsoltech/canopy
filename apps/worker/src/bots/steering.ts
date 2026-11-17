import { NoticeLevel } from "@canopy/contracts";
import type { ThreadEventInit } from "../journal/index.ts";
import type { BotSession } from "./session.ts";

export type BotSteerStatus = "delivered" | "queued" | "unsupported";

type Input = { id: string; text: string; status: BotSteerStatus; sent: boolean; applying?: boolean };

type Sender = (id: string, text: string) => Promise<void>;

/** Transient native writes are sent once. Only a harness consumption event can acknowledge them. */
export class BotSteering {
  readonly #inputs = new Map<string, Input>();
  #sender: Sender | undefined;
  #closed = false;
  #notices = Promise.resolve();
  constructor(
    readonly session: BotSession,
    readonly record: (event: ThreadEventInit) => Promise<void>,
  ) {}

  submit(id: string, text: string): BotSteerStatus {
    const known = this.#inputs.get(id);

    if (known) return known.status;

    if (this.#closed || this.#inputs.size >= 256) return "unsupported";
    // Persist uncertainty before handing any bytes to the provider. Never resume an ambiguous native session.
    this.session.pendingInput(id);
    const input: Input = { id, text, status: "queued", sent: false };
    this.#inputs.set(id, input);
    this.#send(input);

    return input.status;
  }

  ready(sender: Sender): void {
    if (this.#closed) return;
    this.#sender = sender;

    for (const input of this.#inputs.values()) this.#send(input);
  }

  #send(input: Input): void {
    if (!this.#sender || input.sent || this.#closed) return;
    input.sent = true;
    // RPC acceptance is not evidence of consumption. Errors can also hide successful writes; never retry.
    void this.#sender(input.id, input.text).catch(() => {});
  }

  applied(id: string): Promise<void> {
    const input = this.#inputs.get(id);

    if (!input || !input.sent || input.status !== "queued" || input.applying || this.#closed) return this.#notices;
    input.applying = true;
    this.#notices = this.#notices.then(async () => {
      await this.#notice("bot_steer_applied", id);
      // The notice is durable before the session becomes safe to resume.
      this.session.appliedInput(id);
      input.status = "delivered";
    });

    return this.#notices;
  }

  get pending(): boolean {
    return [...this.#inputs.values()].some((input) => input.status === "queued");
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#sender = undefined;
    await this.#notices;

    if (this.pending) this.session.invalidate();

    for (const input of this.#inputs.values()) {
      if (input.status !== "queued") continue;
      input.status = "unsupported";
      await this.#notice("bot_steer_dropped", input.id);
    }
  }

  #notice(code: string, id: string) {
    return this.record({
      body: { case: "notice", value: { code, level: NoticeLevel.INFO, dataJson: JSON.stringify({ input_id: id }) } },
    });
  }
}
