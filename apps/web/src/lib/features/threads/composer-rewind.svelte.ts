import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, type Mention, type ui } from "@canopy/contracts";
import { inlineLegacyQuotes } from "@canopy/domain";
import type { AttachmentDraft, DraftFile } from "#lib/features/attachments/draft.svelte.ts";
import { draftOf, type QuoteDraft } from "#lib/features/quotes/quote.ts";
import type { QuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";

interface SavedDraft {
  text: string;
  mentions: Mention[];
  files: DraftFile[];
  quotes: readonly QuoteDraft[];
}

/** Keep an unsent draft in memory while the rewound message occupies the same composer. */
export class ComposerRewind {
  saved = $state.raw<readonly SavedDraft[]>([]);

  constructor(
    readonly current: () => { threadId: string; text: string; mentions: Mention[] },
    readonly change: (text: string, mentions: Mention[]) => void,
    readonly draft: AttachmentDraft,
    readonly quotes: QuoteDrafts,
  ) {}

  private capture(): SavedDraft {
    const current = this.current();

    return {
      text: current.text,
      mentions: current.mentions,
      files: [...this.draft.files],
      quotes: this.quotes.list(current.threadId),
    };
  }

  load(turn: ui.Turn) {
    const before = this.capture();

    if (before.text || before.files.length || before.quotes.length) this.saved = [...this.saved, before];
    this.draft.files = [];
    this.draft.placed = undefined;
    const restored = inlineLegacyQuotes({ text: turn.messageText, quotes: turn.quotes.map(draftOf) });
    let text = restored.text;
    const mentions = turn.mentions.map((mention) => create(MentionSchema, mention));

    for (const attachment of turn.attachments) {
      // Already-sent files remain editable if today's upload limits are lower; Send validates them again.
      const file: DraftFile = {
        key: crypto.randomUUID(),
        name: attachment.name,
        size: Number(attachment.sizeBytes),
        image: attachment.mimeType.startsWith("image/"),
        localUrl: undefined,
        status: "ready",
        progress: 1,
        error: undefined,
        attachment,
      };

      this.draft.files = [...this.draft.files, file];

      const placed = mentions.filter(
        (mention) => mention.kind === MentionKind.ATTACHMENT && mention.name === attachment.id,
      );

      for (const mention of placed) mention.name = file.key;

      if (placed.length) continue;

      if (text && !/\s$/.test(text)) text += " ";
      const start = text.length;
      text += attachment.name;
      mentions.push(
        create(MentionSchema, {
          kind: MentionKind.ATTACHMENT,
          name: file.key,
          label: attachment.name,
          start,
          end: text.length,
        }),
      );
      text += " ";
    }

    this.quotes.place(this.current().threadId, restored.quotes);
    this.change(text, mentions);
    this.draft.place(mentions);
  }

  swap() {
    const saved = this.saved[0];

    if (!saved) return;
    this.saved = [...this.saved.slice(1), this.capture()];
    this.draft.files = saved.files;
    this.draft.place(saved.mentions);
    this.quotes.place(this.current().threadId, saved.quotes);
    this.change(saved.text, saved.mentions);
  }
}
