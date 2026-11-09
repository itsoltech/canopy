import { create } from "@bufbuild/protobuf";
import { bots, MentionKind, MentionSchema, type ui } from "@canopy/contracts";
import { BotComposerSync } from "@canopy/domain/bot-draft";
import * as Crypto from "expo-crypto";
import type { useSession } from "../../state/session";
import { emptyValue, type MessageValue } from "../composer/message-value";
import type { DraftFile } from "../attachments/useAttachmentDraft";

type Client = NonNullable<ReturnType<typeof useSession>["client"]>;

interface ComposerRef<T> {
  current: T;
}

/** Scoped to the paired client and bot, including in-flight uploads after a screen unmounts. */
export class BotComposerState {
  readonly value = { current: emptyValue };
  readonly files: ComposerRef<DraftFile[]> = { current: [] };
  readonly quotes: ComposerRef<readonly ui.Quote[]> = { current: [] };
  readonly sync: BotComposerSync;
  sending = false;
  version = 0;
  #listeners = new Set<() => void>();
  #editing = false;
  #appliedId: string | undefined;

  constructor(
    readonly client: Client | null,
    readonly id: string,
  ) {
    this.sync = new BotComposerSync(
      id,
      {
        load: () => {
          if (!client) return Promise.reject(new Error("Connect to load the draft."));

          return client.api.getBotDraft({ botId: id });
        },
        save: (draft, revision) => {
          if (!client) return Promise.reject(new Error("Connect to save the draft."));

          return client.api.saveBotDraft({ botId: id, draft, expectedRevision: revision });
        },
      },
      () => Crypto.randomUUID(),
    );
    this.sync.subscribe(() => {
      const next = this.sync.value;

      if (!this.#editing && this.sync.loaded && this.#appliedId !== next.clientRequestId) {
        this.#appliedId = next.clientRequestId;
        this.value.current = { text: next.text, mentions: next.mentions };
        this.quotes.current = next.quotes;
        this.files.current = next.attachments.map((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          size: Number(attachment.sizeBytes),
          kind: "image",
          attachment,
        }));
      }

      this.notify();
    });
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
  notify = () => {
    this.version += 1;

    for (const listener of this.#listeners) listener();
  };

  changed = () => {
    this.persist();
    this.notify();
  };

  persist() {
    if (this.sending) return;
    const files = new Map(this.files.current.map((f) => [f.key, f.attachment]));
    const value: MessageValue = this.value.current;

    const mentions = value.mentions.flatMap((m) => {
      if (m.kind !== MentionKind.ATTACHMENT) return [m];
      const file = files.get(m.name);

      return file ? [create(MentionSchema, { ...m, name: file.id })] : [];
    });

    this.#editing = true;

    try {
      this.sync.update(
        create(bots.BotComposerDraftSchema, {
          text: value.text,
          mentions,
          attachments: this.files.current.flatMap((f) => f.attachment ?? []),
          quotes: [...this.quotes.current],
        }),
      );
      this.#appliedId = this.sync.value.clientRequestId;
    } finally {
      this.#editing = false;
    }
  }
}

const clients = new WeakMap<Client, Map<string, BotComposerState>>();

export function botComposerState(client: Client | null, id: string): BotComposerState {
  if (!client) return new BotComposerState(null, id);
  let drafts = clients.get(client);

  if (!drafts) {
    drafts = new Map();
    clients.set(client, drafts);
  }

  let state = drafts.get(id);

  if (!state) {
    state = new BotComposerState(client, id);
    drafts.set(id, state);
  }

  return state;
}
