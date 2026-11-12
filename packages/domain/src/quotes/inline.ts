import { create } from "@bufbuild/protobuf";
import { MentionSchema, type Mention } from "@canopy/contracts";
import { quoteBlock, quotesNote, type NotedQuote } from "./quotes.ts";

/** A compact, readable marker; its range identifies the citation. */
export function citationLabel(text: string, max = 32): string {
  const line = text.replace(/\s+/g, " ").trim();

  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
}

export const citationPlaceholder = (text: string): string => `[“${citationLabel(text)}”]`;

/** Opening an older saved draft turns its tray quotes into editable tokens at the end. */
export function inlineLegacyQuotes<Q extends NotedQuote>(value: { text: string; quotes: readonly Q[] }) {
  let text = value.text;
  const quotes = value.quotes.filter((q) => q.start !== undefined && q.end !== undefined);

  for (const quote of value.quotes.filter((q) => q.start === undefined || q.end === undefined)) {
    if (text && !/\s$/.test(text)) text += " ";
    const start = text.length;
    text += citationPlaceholder(quote.text);
    quotes.push({ ...quote, start, end: text.length });
    text += " ";
  }

  return { text, quotes };
}

/** Older text-only queue editors retain citations whose markers still occur in order. */
export function relocateQuotes<Q extends NotedQuote>(before: string, quotes: readonly Q[], text: string): Q[] {
  let at = 0;

  return [...quotes]
    .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity))
    .flatMap((q) => {
      if (q.start === undefined || q.end === undefined) return [q];
      const marker = before.slice(q.start, q.end);
      const start = marker ? text.indexOf(marker, at) : -1;

      if (start < 0) return [];
      at = start + marker.length;

      return [{ ...q, start, end: at }];
    });
}

/** Expand citations where the user placed them, moving native mention ranges with the text. */
export function composeQuotes(message: string, mentions: readonly Mention[], quotes: readonly NotedQuote[]) {
  const inline = quotes.filter((q) => q.start !== undefined && q.end !== undefined).sort((a, b) => a.start! - b.start!);
  let text = "";
  let at = 0;
  const shifts: { end: number; by: number }[] = [];

  for (const [index, quote] of inline.entries()) {
    const start = quote.start!;
    const end = quote.end!;
    const comment = quote.comment?.trim();
    const block = `\n\n[canopy citation ${index + 1}]\n${quoteBlock(quote)}${comment ? `\n\nComment: ${comment}` : ""}\n[/canopy citation ${index + 1}]\n\n`;
    text += message.slice(at, start) + block;
    shifts.push({ end, by: block.length - (end - start) });
    at = end;
  }

  text += message.slice(at);

  return {
    message: text,
    mentions: mentions.map((m) => {
      const by = shifts.filter((s) => s.end <= m.start).reduce((sum, s) => sum + s.by, 0);

      return create(MentionSchema, { ...m, start: m.start + by, end: m.end + by });
    }),
    note: quotesNote(quotes.filter((q) => q.start === undefined)),
  };
}
