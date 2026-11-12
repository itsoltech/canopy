import { create, toJsonString } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";

export interface BotDraftTransport {
  load(): Promise<bots.BotComposerDraft>;
  save(draft: bots.BotComposerDraft, revision: bigint): Promise<bots.BotComposerDraft>;
}

/** Serial, revision-checked gateway writes shared by web and mobile. Never writes browser/device storage. */
export class BotComposerSync {
  value: bots.BotComposerDraft;
  loaded = false;
  error = "";
  #dirty = false;
  #version = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #loading: Promise<void> | undefined;
  #saving: Promise<void> | undefined;
  #listeners = new Set<() => void>();

  constructor(
    readonly botId: string,
    readonly transport: BotDraftTransport,
    readonly newId: () => string,
  ) {
    this.value = create(bots.BotComposerDraftSchema, { botId });
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  #notify() {
    for (const listener of this.#listeners) listener();
  }

  async load(): Promise<void> {
    if (this.#loading) return this.#loading;

    if (this.#dirty || this.#saving) return;
    const version = this.#version;
    this.#loading = this.transport
      .load()
      .then((draft) => {
        if (!this.#dirty && this.#version === version) {
          this.value = draft;
          this.loaded = true;
          this.error = "";
          this.#notify();
        }
      })
      .catch(() => {
        this.error = "Could not load the draft. Check the connection and reopen this conversation.";
        this.#notify();
      })
      .finally(() => {
        this.#loading = undefined;
      });

    return this.#loading;
  }

  update(draft: bots.BotComposerDraft): void {
    const next = create(bots.BotComposerDraftSchema, {
      ...draft,
      botId: this.botId,
      revision: this.value.revision,
      clientRequestId: this.value.clientRequestId,
    });

    if (
      !this.loaded ||
      toJsonString(bots.BotComposerDraftSchema, next) === toJsonString(bots.BotComposerDraftSchema, this.value)
    )
      return;
    this.value = { ...next, clientRequestId: this.newId() };
    this.#dirty = true;
    this.#version += 1;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, 350);
    this.#notify();
  }

  async flush(): Promise<void> {
    clearTimeout(this.#timer);

    if (this.#saving) {
      await this.#saving;

      return this.flush();
    }

    if (!this.#dirty) return;
    const version = this.#version;
    const draft = this.value;
    this.#saving = this.transport
      .save(draft, draft.revision)
      .then((saved) => {
        this.value = { ...this.value, revision: saved.revision };
        this.#dirty = this.#version !== version;
        this.error = "";
      })
      .catch((cause: Error) => {
        this.error = cause.message || "Could not save the draft. Check the connection and retry.";
        throw cause;
      })
      .finally(() => {
        this.#saving = undefined;
        this.#notify();
      });
    await this.#saving;

    if (this.#dirty) await this.flush();
  }

  /** The message stays in the draft until acknowledged. Transport failures preserve it and its request id. */
  async outgoing(): Promise<bots.BotComposerDraft> {
    if (!this.loaded) throw new Error("Wait for the draft to load.");
    await this.flush();

    if (!this.value.clientRequestId) this.value = { ...this.value, clientRequestId: this.newId() };

    return this.value;
  }

  async sent(sent: bots.BotComposerDraft): Promise<void> {
    if (sent.clientRequestId !== this.value.clientRequestId) return;
    clearTimeout(this.#timer);
    this.#version += 1;
    this.value = create(bots.BotComposerDraftSchema, { botId: this.botId, revision: sent.revision + 1n });
    this.#dirty = false;
    this.#notify();
    // A read started before acknowledgement can still contain the just-sent files.
    await this.#loading;
    await this.load();
  }

  /** Explicitly replace local edits with the saved draft after a revision conflict. */
  async reload(): Promise<void> {
    clearTimeout(this.#timer);
    await this.#saving?.catch(() => {});
    this.#dirty = false;
    await this.load();
  }
}
