import { create } from "@bufbuild/protobuf";
import { bots, type Mention, ui } from "@canopy/contracts";
import { BotComposerSync } from "@canopy/domain/bot-draft";
import { inlineLegacyQuotes, type AttachmentLimits } from "@canopy/domain";
import { AttachmentDraft } from "#lib/features/attachments/draft.svelte.ts";
import { useQuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";
import { trimValue } from "#lib/features/mentions/editor.ts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";
import { draftOf, toWire } from "#lib/features/quotes/quote.ts";

/** Per-bot pending uploads survive unmounts; the canonical message is saved to the gateway. */
export class BotComposerDraft {
  text = $state("");
  mentions = $state<Mention[]>([]);
  loaded = $state(false);
  error = $state("");
  sending = $state(false);
  readonly files: AttachmentDraft;
  readonly sync: BotComposerSync;
  readonly quoteKey: string;
  #appliedId: string | undefined;
  #editing = false;

  constructor(
    readonly botId: string,
    limits: () => AttachmentLimits,
  ) {
    this.quoteKey = `bot:${botId}`;
    this.files = new AttachmentDraft(limits, { botId, onUploaded: () => this.persist() });
    const path = `/api/bots/${encodeURIComponent(botId)}/draft`;
    this.sync = new BotComposerSync(
      botId,
      {
        load: async () => decode(bots.BotComposerDraftSchema, await requestJson("GET", path)),
        save: async (draft, revision) =>
          decode(
            bots.BotComposerDraftSchema,
            await requestJson(
              "PUT",
              path,
              encode(
                bots.SaveBotDraftRequestSchema,
                create(bots.SaveBotDraftRequestSchema, { botId, draft, expectedRevision: revision }),
              ),
            ),
          ),
      },
      () => crypto.randomUUID(),
    );
    this.sync.subscribe(() => this.#receive());
  }

  #receive() {
    this.loaded = this.sync.loaded;
    this.error = this.sync.error;
    const next = this.sync.value;

    if (this.#editing || !this.loaded || this.#appliedId === next.clientRequestId) return;
    this.#appliedId = next.clientRequestId;
    const restored = inlineLegacyQuotes(next);
    this.text = restored.text;
    this.mentions = next.mentions;
    this.files.clear();
    this.files.files = next.attachments.map((a) => ({
      key: a.id,
      name: a.name,
      size: Number(a.sizeBytes),
      image: true,
      localUrl: undefined,
      status: "ready",
      progress: 1,
      error: undefined,
      attachment: a,
    }));
    useQuoteDrafts().restore(this.quoteKey, restored.quotes);
  }

  persist() {
    this.files.place(this.mentions);

    if (!this.loaded || this.sending) return;
    this.#editing = true;

    try {
      this.sync.update(
        create(bots.BotComposerDraftSchema, {
          text: this.text,
          mentions: this.files.wire(this.mentions),
          attachments: this.files.attached.flatMap((f) => f.attachment ?? []),
          quotes: useQuoteDrafts().wire(this.quoteKey),
        }),
      );
      this.#appliedId = this.sync.value.clientRequestId;
    } finally {
      this.#editing = false;
    }
  }

  async send(
    deliver: (
      text: string,
      mentions: Mention[],
      quotes: ui.Quote[],
      attachments: ui.Attachment[],
      requestId: string,
      revision: bigint,
    ) => boolean | void | Promise<boolean | void>,
  ) {
    if (this.sending || this.files.blocker) return;
    this.persist();
    this.sending = true;

    try {
      const draft = await this.sync.outgoing();
      const trimmed = trimValue({ text: draft.text, mentions: draft.mentions, quotes: draft.quotes.map(draftOf) });

      if (
        (await deliver(
          trimmed.text,
          trimmed.mentions,
          (trimmed.quotes ?? []).map((q) => create(ui.QuoteSchema, toWire(q))),
          draft.attachments,
          draft.clientRequestId,
          draft.revision,
        )) !== false
      )
        await this.sync.sent(draft);
    } catch {
      this.error = this.sync.error || "Could not confirm delivery. Check the connection and send this message again.";
    } finally {
      this.sending = false;
    }
  }
}

const drafts = new Map<string, BotComposerDraft>();

export function botComposerDraft(botId: string, limits: () => AttachmentLimits): BotComposerDraft {
  let draft = drafts.get(botId);

  if (!draft) {
    draft = new BotComposerDraft(botId, limits);
    drafts.set(botId, draft);
  }

  return draft;
}
