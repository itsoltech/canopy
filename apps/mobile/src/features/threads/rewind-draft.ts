import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, type ui } from "@canopy/contracts";
import { inlineLegacyQuotes } from "@canopy/domain";
import * as Crypto from "expo-crypto";
import { attachmentKind } from "../attachments/attachment-display";
import type { MessageDraft } from "../composer/useMessageDraft";

/** Historical uploads get new gateway bindings; editor chips use fresh local keys. */
export function rewindDraft(turn: ui.Turn): ReturnType<MessageDraft["snapshot"]> {
  const restored = inlineLegacyQuotes({ text: turn.messageText, quotes: turn.quotes });
  let text = restored.text;
  const mentions = turn.mentions.map((mention) => create(MentionSchema, mention));

  const files = turn.attachments.map((attachment) => {
    const key = Crypto.randomUUID();

    const placed = mentions.filter(
      (mention) => mention.kind === MentionKind.ATTACHMENT && mention.name === attachment.id,
    );

    for (const mention of placed) mention.name = key;

    if (!placed.length) {
      if (text && !/\s$/.test(text)) text += " ";
      const start = text.length;
      text += attachment.name;
      mentions.push(
        create(MentionSchema, {
          kind: MentionKind.ATTACHMENT,
          name: key,
          label: attachment.name,
          start,
          end: text.length,
        }),
      );
      text += " ";
    }

    return {
      key,
      name: attachment.name,
      size: Number(attachment.sizeBytes),
      kind: attachmentKind(attachment.name, attachment.mimeType),
      mimeType: attachment.mimeType,
      attachment,
      previewUri: undefined,
      temporary: false,
    };
  });

  return { value: { text, mentions, quotes: restored.quotes }, files };
}
