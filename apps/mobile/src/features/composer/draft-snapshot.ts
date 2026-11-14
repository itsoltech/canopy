import { clone } from "@bufbuild/protobuf";
import { MentionSchema, ui } from "@canopy/contracts";
import type { DraftFile } from "../attachments/useAttachmentDraft";
import type { MessageValue } from "./message-value";

export type ComposerChoices = Pick<
  ui.ComposerDraftContent,
  "model" | "effort" | "permissionMode" | "provider" | "providerProfileId"
>;

export interface MessageSnapshot {
  value: MessageValue;
  files: DraftFile[];
  choices?: ComposerChoices;
}

/** Backups own uploaded bindings, never native preview files or gateway revisions. */
export function snapshotDraft(
  value: MessageValue,
  files: readonly DraftFile[],
  choices?: ComposerChoices,
): MessageSnapshot {
  if (files.some((file) => !file.attachment || file.error))
    throw new Error("Wait for uploads, or remove the files that could not be attached.");

  return {
    value: {
      text: value.text,
      mentions: value.mentions.map((m) => clone(MentionSchema, m)),
      quotes: value.quotes?.map((q) => clone(ui.QuoteSchema, q)),
    },
    files: files.map((file) => ({ ...file, previewUri: undefined, temporary: false })),
    choices: choices ? { ...choices } : undefined,
  };
}
