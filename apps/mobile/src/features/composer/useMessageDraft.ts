import { useRef, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, type Mention, type ui } from "@canopy/contracts";
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
  insertCitation,
  isPlacedQuote,
} from "./message-value";
import type { DraftFile } from "../attachments/useAttachmentDraft";
import { CitationHistory } from "./citation-history";
import type { MobileComposerState } from "../drafts/store";
import { snapshotDraft, type MessageSnapshot } from "./draft-snapshot";

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
    keepAlive?: boolean;
    persistent?: MobileComposerState;
  } = {},
) {
  const [localValue, setValue] = useState<MessageValue>(emptyValue);
  const composerSelection = useComposerSelection();
  const { caret, setCaret, selection, hasSelection, focusAt } = composerSelection;
  // Read at once by picks that land in one tick (several photos at a time).
  const local = useRef<MessageValue>(emptyValue);
  const current = options.value ?? local;
  const value = options.value ? current.current : localValue;
  useUpdateBlocker(() => current.current.text.length > 0);
  const history = useRef(new CitationHistory());

  const apply = (next: MessageValue) => {
    if (options.persistent?.locked) return;
    history.current.remember(next);
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
      keepAlive: Boolean(options.botId) || options.keepAlive,
      botId: options.botId,
      onChange: options.onChange,
      locked: () => Boolean(options.persistent?.locked),
    },
  );

  const badges = draftBadges(value, files.files, composerSelection, current, apply);

  const trigger = mentionTrigger(value, caret);

  return {
    persistent: options.persistent,
    value,
    files,
    badges,
    snapshot: () => snapshotDraft(current.current, options.files?.current ?? files.files, options.persistent?.choices),
    restore(next: MessageSnapshot) {
      if (options.persistent?.locked) throw new Error("Retry the pending message before restoring a draft.");
      const restored = snapshotDraft(next.value, next.files, next.choices);
      files.replace(restored.files);
      options.persistent?.renewMessage(restored.choices);
      history.current.clear();
      selection.current = { start: restored.value.text.length, end: restored.value.text.length };
      hasSelection.current = false;
      setCaret(undefined);
      apply(restored.value);
      focusAt.current?.(restored.value.text.length);
    },
    addQuote(quote: ui.Quote) {
      const at = hasSelection.current ? selection.current.start : current.current.text.length;
      const placed = insertCitation(current.current, { start: at, end: at }, quote);
      selection.current = { start: placed.caret, end: placed.caret };
      apply(placed.value);
      focusAt.current?.(placed.caret);
    },
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
      history.current.remember(current.current);
      const edited = editText(current.current, next);

      apply(history.current.restore(edited.value));

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
      hasSelection.current = false;
      history.current.clear();
      setCaret(undefined);
      apply(emptyValue);
      options.persistent?.clear();
    },
    /** What the gateway gets: trimmed text, mentions with stored attachment ids, the files' ids. */
    outgoing: () => outgoingMessage(current.current, files.files),
  };
}

export type MessageDraft = ReturnType<typeof useMessageDraft>;

function replaceCitation(value: MessageValue, index: number, quote: ui.Quote) {
  const old = value.quotes?.[index];

  if (!old || !isPlacedQuote(old)) return;
  const removed = editText(value, value.text.slice(0, old.start) + value.text.slice(old.end)).value;

  return insertCitation(removed, { start: old.start, end: old.start }, quote);
}

function draftBadges(
  value: MessageValue,
  files: readonly DraftFile[],
  { focusAt, hasSelection, selection, setCaret }: ReturnType<typeof useComposerSelection>,
  current: { current: MessageValue },
  apply: (next: MessageValue) => void,
): ComposerBadges {
  const status = attachmentTones(files);

  return {
    mentions: value.mentions,
    quotes: value.quotes ?? [],
    focusAt,
    onSelect: (next) => {
      hasSelection.current = true;
      selection.current = next;
      setCaret(next.start === next.end ? next.start : undefined);
    },
    tone: (m) => (isAttachment(m) ? status.get(m.name) : undefined),
    editQuote(index, quote) {
      const placed = replaceCitation(current.current, index, quote);

      if (!placed) return;
      apply(placed.value);
      focusAt.current?.(placed.caret);
    },
    removeQuote(index) {
      const old = current.current.quotes?.[index];

      if (!old || !isPlacedQuote(old)) return;
      apply(
        editText(current.current, current.current.text.slice(0, old.start) + current.current.text.slice(old.end)).value,
      );
      focusAt.current?.(old.start);
    },
  };
}

function useComposerSelection() {
  // The collapsed caret identifies the mention trigger; selections have no trigger.
  const [caret, setCaret] = useState<number>();
  const selection = useRef({ start: 0, end: 0 });
  const hasSelection = useRef(false);
  const focusAt = useRef<((caret: number) => void) | undefined>(undefined);

  return { caret, setCaret, selection, hasSelection, focusAt };
}

function attachmentTones(files: readonly DraftFile[]) {
  return new Map<string, BadgeTone>(
    files.map((f) => [f.key, f.error ? "failed" : f.attachment ? undefined : "uploading"]),
  );
}

function mentionTrigger(value: MessageValue, caret: number | undefined) {
  const inBadge = caret !== undefined && value.mentions.some((m) => m.start < caret && caret <= m.end);

  return caret === undefined || inBadge ? undefined : activeTrigger(value.text.slice(0, caret));
}

function outgoingMessage(value: MessageValue, files: readonly DraftFile[]) {
  const trimmed = trimValue(value);
  const stored = new Map(files.flatMap((f) => (f.attachment ? [[f.key, f.attachment.id] as const] : [])));

  const mentions = trimmed.mentions.flatMap((m) => {
    if (!isAttachment(m)) return [m];
    const id = stored.get(m.name);

    return id ? [create(MentionSchema, { ...m, name: id })] : [];
  });

  return { text: trimmed.text, mentions, quotes: [...(trimmed.quotes ?? [])], attachmentIds: [...stored.values()] };
}
