import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, type Mention, type ui } from "@canopy/contracts";
import { citationTokenLabel } from "@canopy/domain";
import { mentionPlaceholder } from "@canopy/domain/mentions";

/**
 * A message as the composer holds it: the text and the mentions placed in it, each covering its placeholder
 * ("[photo.png]" for a file, docs/ui-api.md). A badge lives as a whole: an edit that touches it removes all of it,
 * and typing inside it moves the typed text after it. The same model serves the composer and the queue editor.
 */
export interface MessageValue {
  readonly text: string;
  readonly mentions: readonly Mention[];
  readonly quotes?: readonly ui.Quote[] | undefined;
}

export const emptyValue: MessageValue = { text: "", mentions: [] };

/** A value with a mention inserted, and where the caret goes. */
export interface Placed {
  readonly value: MessageValue;
  readonly caret: number;
}

/** A value after an edit, and the mentions the edit removed. */
export interface Edited {
  readonly value: MessageValue;
  readonly removed: Mention[];
}

const byStart = (mentions: readonly Mention[]) => [...mentions].sort((a, b) => a.start - b.start);

const moved = (m: Mention, by: number) => create(MentionSchema, { ...m, start: m.start + by, end: m.end + by });

/** The placeholder of `mention` inserted over [start, end) of the text, with a space after it; the caret after that. */
export function insertMention(
  value: MessageValue,
  selection: { start: number; end: number },
  mention: Pick<Mention, "kind" | "name" | "label"> & Partial<Pick<Mention, "path" | "source" | "isDir">>,
): Placed {
  // Never inside another badge: the insertion point moves past it.
  const inside = [...value.mentions, ...(value.quotes ?? []).filter(isPlacedQuote)].find(
    (m) => m.start < selection.start && selection.start < m.end,
  );

  const start = inside ? inside.end : Math.min(selection.start, value.text.length);
  const end = inside ? inside.end : Math.max(start, Math.min(selection.end, value.text.length));
  const placeholder = mentionPlaceholder(mention);
  const before = value.text.slice(0, start);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const after = value.text.slice(end);
  const trail = after.startsWith(" ") ? "" : " ";
  const at = start + lead.length;
  const added = create(MentionSchema, { ...mention, start: at, end: at + placeholder.length });
  const shift = lead.length + placeholder.length + trail.length - (end - start);

  const mentions = value.mentions.flatMap((m) => (m.end <= start ? [m] : m.start >= end ? [moved(m, shift)] : []));

  const quotes = value.quotes?.flatMap((q) =>
    q.start === undefined || q.end === undefined || q.end <= start
      ? [q]
      : q.start >= end
        ? [{ ...q, start: q.start + shift, end: q.end + shift }]
        : [],
  );

  return {
    value: { text: before + lead + placeholder + trail + after, mentions: byStart([...mentions, added]), quotes },
    caret: at + placeholder.length + trail.length,
  };
}

/**
 * The value after the field reported `next`: the changed range found by the common prefix and suffix. A badge the
 * change touches goes whole (`removed` lists them); text typed inside a badge lands after it.
 */
export function editText(value: MessageValue, next: string): Edited {
  const before = value.text;
  let prefix = 0;
  const shortest = Math.min(before.length, next.length);

  while (prefix < shortest && before[prefix] === next[prefix]) prefix++;
  let suffix = 0;

  while (suffix < shortest - prefix && before[before.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  let start = prefix;
  let end = before.length - suffix;
  const inserted = next.slice(prefix, next.length - suffix);

  if (start === end) {
    const host = [...value.mentions, ...(value.quotes ?? []).filter(isPlacedQuote)].find(
      (m) => m.start < start && start < m.end,
    );

    if (host) {
      start = host.end;
      end = host.end;
    }
  }

  const touched = [...value.mentions, ...(value.quotes ?? []).filter(isPlacedQuote)].filter(
    (m) => start < end && m.start < end && m.end > start,
  );

  const removed = value.mentions.filter((m) => touched.includes(m));

  for (const m of touched) {
    start = Math.min(start, m.start);
    end = Math.max(end, m.end);
  }

  const shift = inserted.length - (end - start);

  const mentions = value.mentions.flatMap((m) => (removed.includes(m) ? [] : m.end <= start ? [m] : [moved(m, shift)]));

  const quotes = value.quotes?.flatMap((q) =>
    !isPlacedQuote(q) || q.end <= start
      ? [q]
      : q.start >= end
        ? [{ ...q, start: q.start + shift, end: q.end + shift }]
        : [],
  );

  return { value: { text: before.slice(0, start) + inserted + before.slice(end), mentions, quotes }, removed };
}

/** The value without one mention's placeholder (its file was removed from the tray). */
export function withoutMention(value: MessageValue, name: string): MessageValue {
  const mention = value.mentions.find((m) => m.name === name);

  if (!mention) return value;
  const tail = value.text.slice(mention.end).startsWith(" ") ? 1 : 0;

  return editText(value, value.text.slice(0, mention.start) + value.text.slice(mention.end + tail)).value;
}

/** The value without surrounding whitespace, ranges moved along (mentions are never whitespace). */
export function trimValue(value: MessageValue): MessageValue {
  const lead = value.text.length - value.text.trimStart().length;
  const text = value.text.trim();

  return {
    text,
    mentions: value.mentions.filter((m) => m.end - lead <= text.length).map((m) => moved(m, -lead)),
    quotes: value.quotes?.map((q) => (isPlacedQuote(q) ? { ...q, start: q.start - lead, end: q.end - lead } : q)),
  };
}

export interface Segment {
  readonly text: string;
  readonly mention?: Mention | undefined;
  readonly quote?: ui.Quote | undefined;
}

/** Shared UTF-16 ranges for composer spans and sent-message Markdown elements. */
export function rangesOf(value: MessageValue) {
  return [
    ...value.mentions.map((mention) => ({ start: mention.start, end: mention.end, mention, quote: undefined })),
    ...(value.quotes ?? [])
      .filter(isPlacedQuote)
      .map((quote) => ({ start: quote.start, end: quote.end, quote, mention: undefined })),
  ].sort((a, b) => a.start - b.start);
}

/** The text cut at its mentions and citations, for rendering badges in place. */
export function segmentsOf(value: MessageValue): Segment[] {
  const out: Segment[] = [];
  let at = 0;

  for (const m of rangesOf(value)) {
    if (m.start < at || m.end > value.text.length) continue;

    if (m.start > at) out.push({ text: value.text.slice(at, m.start) });
    out.push({ text: value.text.slice(m.start, m.end), mention: m.mention, quote: m.quote });
    at = m.end;
  }

  if (at < value.text.length) out.push({ text: value.text.slice(at) });

  return out;
}

export const isAttachment = (m: Mention) => m.kind === MentionKind.ATTACHMENT;

export const isPlacedQuote = (q: ui.Quote): q is ui.Quote & { start: number; end: number } =>
  q.start !== undefined && q.end !== undefined;

export function insertCitation(
  value: MessageValue,
  selection: { start: number; end: number },
  quote: ui.Quote,
): Placed {
  const host = value.quotes?.filter(isPlacedQuote).find((q) => q.start < selection.start && selection.start < q.end);
  const at = host ? { start: host.end, end: host.end } : selection;

  const placed = insertMention(value, at, {
    kind: MentionKind.ATTACHMENT,
    name: "citation",
    label: quote.pullRequest ? `⑂ ${citationTokenLabel(quote)}` : `“${citationTokenLabel(quote)}”`,
  });

  const marker = placed.value.mentions.find((m) => m.name === "citation" && m.kind === MentionKind.ATTACHMENT)!;

  return {
    caret: placed.caret,
    value: {
      ...placed.value,
      mentions: placed.value.mentions.filter((m) => m !== marker),
      quotes: [...(placed.value.quotes ?? []), { ...quote, start: marker.start, end: marker.end }].sort(
        (a, b) => (a.start ?? Infinity) - (b.start ?? Infinity),
      ),
    },
  };
}
