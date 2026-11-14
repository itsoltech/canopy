import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, type ui } from "@canopy/contracts";
import { inlineLegacyQuotes } from "@canopy/domain";
import type { DraftFile } from "#lib/features/attachments/draft.svelte.ts";
import { draftOf } from "#lib/features/quotes/quote.ts";
import type { ComposerSnapshot, WebComposerDraft } from "#lib/features/drafts/state.svelte.ts";

/** Keep an unsent draft in memory while the rewound message occupies the same composer. */
export class ComposerRewind {
  saved = $state.raw<readonly ComposerSnapshot[]>([]);

  constructor(readonly composer: WebComposerDraft) {}

  load(turn: ui.Turn) {
    const before = this.composer.snapshot();
    const restored = inlineLegacyQuotes({ text: turn.messageText, quotes: turn.quotes.map(draftOf) });
    let text = restored.text;
    const mentions = turn.mentions.map((mention) => create(MentionSchema, mention));
    const files: DraftFile[] = [];

    for (const attachment of turn.attachments) {
      // Already-sent files remain editable if today's upload limits are lower; Send validates them again.
      const file: DraftFile = {
        key: crypto.randomUUID(),
        name: attachment.name,
        size: Number(attachment.sizeBytes),
        image: attachment.mimeType.startsWith("image/"),
        video: attachment.kind === "video",
        localUrl: undefined,
        status: "ready",
        progress: 1,
        error: undefined,
        attachment,
      };

      files.push(file);

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

    this.composer.restore({ text, mentions, files, quotes: restored.quotes });

    if (before.text || before.files.length || before.quotes.length) this.saved = [...this.saved, before];
  }

  swap() {
    const saved = this.saved[0];

    if (!saved) return;
    const current = this.composer.snapshot();
    this.composer.restore(saved);
    this.saved = [...this.saved.slice(1), current];
  }
}
