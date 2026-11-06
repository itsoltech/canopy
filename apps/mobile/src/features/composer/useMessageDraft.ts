import { useRef, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema } from "@canopy/contracts";
import { useAttachmentDraft } from "../attachments/useAttachmentDraft";
import type { ComposerBadges } from "../threads/ComposerBox";
import type { BadgeTone } from "./MessageText";
import {
  editText,
  emptyValue,
  insertMention,
  isAttachment,
  trimValue,
  withoutMention,
  type MessageValue,
} from "./message-value";

/**
 * The next message: its text, the mentions placed in it and its files. A picked file's badge goes in at the caret,
 * as on the web; removing the badge removes the file and removing the file removes its badge. While composing, a
 * badge names the file's draft key; `outgoing` swaps in the stored attachment's id.
 */
export function useMessageDraft() {
  const [value, setValue] = useState<MessageValue>(emptyValue);
  // Read at once by picks that land in one tick (several photos at a time).
  const current = useRef<MessageValue>(emptyValue);
  const selection = useRef({ start: 0, end: 0 });

  const apply = (next: MessageValue) => {
    current.current = next;
    setValue(next);
  };

  const files = useAttachmentDraft((file) => {
    const placed = insertMention(current.current, selection.current, {
      kind: MentionKind.ATTACHMENT,
      name: file.key,
      label: file.name,
    });

    selection.current = { start: placed.caret, end: placed.caret };
    apply(placed.value);
  });

  const status = new Map<string, BadgeTone>(
    files.files.map((f) => [f.key, f.error ? "failed" : f.attachment ? undefined : "uploading"]),
  );

  const badges: ComposerBadges = {
    mentions: value.mentions,
    onSelect: (next) => {
      selection.current = next;
    },
    tone: (m) => (isAttachment(m) ? status.get(m.name) : undefined),
  };

  return {
    value,
    files,
    badges,
    setText(next: string) {
      const edited = editText(current.current, next);

      apply(edited.value);

      for (const m of edited.removed) if (isAttachment(m)) files.remove(m.name);
    },
    /** Removes a file and its badge. */
    remove(key: string) {
      files.remove(key);
      apply(withoutMention(current.current, key));
    },
    clear() {
      files.clear();
      selection.current = { start: 0, end: 0 };
      apply(emptyValue);
    },
    /** What the gateway gets: trimmed text, mentions with stored attachment ids, the files' ids. */
    outgoing() {
      const trimmed = trimValue(current.current);
      const stored = new Map(files.files.flatMap((f) => (f.attachment ? [[f.key, f.attachment.id] as const] : [])));

      const mentions = trimmed.mentions.flatMap((m) => {
        if (!isAttachment(m)) return [m];
        const id = stored.get(m.name);

        return id ? [create(MentionSchema, { ...m, name: id })] : [];
      });

      return { text: trimmed.text, mentions, attachmentIds: [...stored.values()] };
    },
  };
}

export type MessageDraft = ReturnType<typeof useMessageDraft>;
