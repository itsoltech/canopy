import { useRef, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, type Mention } from "@canopy/contracts";
import { useAttachmentDraft } from "../attachments/useAttachmentDraft";
import type { ComposerBadges } from "../threads/ComposerBox";
import type { BadgeTone } from "./MessageText";
import { activeTrigger } from "./useMentionSuggestions";
import { useUpdateBlocker } from "../updates/useUpdateBlocker";
import {
  editText,
  emptyValue,
  insertMention,
  isAttachment,
  trimValue,
  withoutMention,
  type MessageValue,
} from "./message-value";
import type { DraftFile } from "../attachments/useAttachmentDraft";

/**
 * The next message: its text, the mentions placed in it and its files. A picked file's badge goes in at the caret,
 * as on the web; removing the badge removes the file and removing the file removes its badge. While composing, a
 * badge names the file's draft key; `outgoing` swaps in the stored attachment's id.
 */
export function useMessageDraft(
  options: {
    value?: { current: MessageValue };
    files?: { current: DraftFile[] };
    onChange?: () => void;
    botId?: string;
  } = {},
) {
  const [localValue, setValue] = useState<MessageValue>(emptyValue);
  // The collapsed caret, for the mention trigger before it (undefined while text is selected).
  const [caret, setCaret] = useState<number>();
  // Read at once by picks that land in one tick (several photos at a time).
  const local = useRef<MessageValue>(emptyValue);
  const current = options.value ?? local;
  const value = options.value ? current.current : localValue;
  useUpdateBlocker(() => current.current.text.length > 0);
  const selection = useRef({ start: 0, end: 0 });

  const apply = (next: MessageValue) => {
    current.current = next;
    setValue(next);
    options.onChange?.();
  };

  const files = useAttachmentDraft(
    (file) => {
      const placed = insertMention(current.current, selection.current, {
        kind: MentionKind.ATTACHMENT,
        name: file.key,
        label: file.name,
      });

      selection.current = { start: placed.caret, end: placed.caret };
      apply(placed.value);
    },
    {
      current: options.files,
      keepAlive: Boolean(options.botId),
      botId: options.botId,
      onChange: options.onChange,
    },
  );

  const status = new Map<string, BadgeTone>(
    files.files.map((f) => [f.key, f.error ? "failed" : f.attachment ? undefined : "uploading"]),
  );

  const badges: ComposerBadges = {
    mentions: value.mentions,
    onSelect: (next) => {
      selection.current = next;
      setCaret(next.start === next.end ? next.start : undefined);
    },
    tone: (m) => (isAttachment(m) ? status.get(m.name) : undefined),
  };

  const inBadge = caret !== undefined && value.mentions.some((m) => m.start < caret && caret <= m.end);
  const trigger = caret === undefined || inBadge ? undefined : activeTrigger(value.text.slice(0, caret));

  return {
    value,
    files,
    badges,
    /** The mention trigger the caret is in ("/rev", "@src/ap"). */
    trigger,
    /** Replaces the trigger and its query with the picked mention's badge. */
    pickMention(mention: Pick<Mention, "kind" | "name" | "label" | "path" | "source" | "isDir">) {
      if (!trigger || caret === undefined) return;
      const placed = insertMention(current.current, { start: caret - trigger.length, end: caret }, mention);

      selection.current = { start: placed.caret, end: placed.caret };
      setCaret(placed.caret);
      apply(placed.value);
    },
    setText(next: string) {
      const edited = editText(current.current, next);

      apply(edited.value);

      for (const m of edited.removed) if (isAttachment(m)) files.remove(m.name);
    },
    appendText(text: string) {
      apply({ ...current.current, text: `${current.current.text}${current.current.text ? "\n\n" : ""}${text}` });
    },
    /** Removes a file and its badge. */
    remove(key: string) {
      files.remove(key);
      apply(withoutMention(current.current, key));
    },
    clear() {
      files.clear();
      selection.current = { start: 0, end: 0 };
      setCaret(undefined);
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
