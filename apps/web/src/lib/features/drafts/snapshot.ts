import type { Mention } from "@canopy/contracts";
import type { DraftFile } from "#lib/features/attachments/draft.svelte.ts";
import type { QuoteDraft } from "#lib/features/quotes/quote.ts";
import { useQuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";
import type { DraftChoices } from "./draft-content.ts";
import type { WebComposerDraft } from "./state.svelte.ts";

export interface ComposerSnapshot {
  text: string;
  mentions: Mention[];
  files: DraftFile[];
  quotes: readonly QuoteDraft[];
  choices?: DraftChoices;
}

export function snapshotComposer(draft: WebComposerDraft): ComposerSnapshot {
  if (draft.files.blocker) throw new Error(draft.files.blocker);
  draft.activate();

  return {
    text: draft.text,
    mentions: draft.mentions.map((mention) => ({ ...mention })),
    files: draft.files.attached.map((file) => ({ ...file, localUrl: undefined, localHeic: undefined })),
    quotes: useQuoteDrafts()
      .list(draft.quoteKey)
      .map((quote) => ({ ...quote })),
    choices: { ...draft.choices },
  };
}

export function restoreComposer(draft: WebComposerDraft, snapshot: ComposerSnapshot) {
  if (draft.locked) throw new Error("Retry the pending message before restoring a draft.");

  if (draft.files.blocker) throw new Error(draft.files.blocker);

  if (snapshot.files.some((file) => !file.attachment || file.status !== "ready"))
    throw new Error("Wait for uploads, or remove the files that could not be attached.");
  // Hydrate once so a later mount cannot restore stale citations over the replacement.
  draft.activate();
  draft.files.clear();
  draft.files.files = snapshot.files.map((file) => ({ ...file, localUrl: undefined, localHeic: undefined }));
  draft.text = snapshot.text;
  draft.mentions = snapshot.mentions.map((mention) => ({ ...mention }));
  useQuoteDrafts().place(
    draft.quoteKey,
    snapshot.quotes.map((quote) => ({ ...quote })),
  );

  if (snapshot.choices) draft.choices = { ...snapshot.choices };
}
