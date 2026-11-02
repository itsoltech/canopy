import type { ui } from "@open-agents/contracts";
import { QUOTE_LIMITS, isQuoteSourceKind, joinNotes, quotesNote, withAttachmentsNote } from "@open-agents/domain";
import type { StoredQuote } from "../store/quotes.ts";
import type { TurnRow } from "../store/store.ts";

const MAX_ID = 200;

/**
 * The quotes of a message, checked (docs/ui-api.md, "Cytaty"): within the limits, non-empty text, a known source
 * kind. The source ids are kept as given: they only point the UI back to the quoted item.
 */
export function checkedQuotes(quotes: readonly ui.Quote[], invalid: (message: string) => Error): StoredQuote[] {
  if (quotes.length > QUOTE_LIMITS.maxQuotes) throw invalid(`up to ${QUOTE_LIMITS.maxQuotes} quotes can go with one message`);
  return quotes.map((quote, index) => {
    const label = `quote ${index + 1}`;
    if (!quote.text.trim()) throw invalid(`${label} is empty`);
    if (quote.text.length > QUOTE_LIMITS.maxTextChars) throw invalid(`${label} is longer than ${QUOTE_LIMITS.maxTextChars} characters`);
    if (quote.comment.length > QUOTE_LIMITS.maxCommentChars) throw invalid(`the comment on ${label} is longer than ${QUOTE_LIMITS.maxCommentChars} characters`);
    if (quote.sourceKind && !isQuoteSourceKind(quote.sourceKind)) throw invalid(`${label} has an unknown source kind "${quote.sourceKind}"`);
    if (quote.sourceItemId.length > MAX_ID || quote.sourceThreadId.length > MAX_ID || quote.language.length > 40) throw invalid(`${label} has an invalid source`);
    return {
      text: quote.text,
      ...(quote.comment.trim() && { comment: quote.comment.trim() }),
      ...(quote.sourceItemId && { sourceItemId: quote.sourceItemId }),
      ...(quote.sourceThreadId && { sourceThreadId: quote.sourceThreadId }),
      ...(quote.sourceKind && { sourceKind: quote.sourceKind }),
      ...(quote.language && { language: quote.language }),
    };
  });
}

/**
 * The input with the message's quotes: their note follows any other note (attachments), the user's text comes
 * last. Without quotes the input is unchanged.
 */
export function withQuotes<I extends TurnRow["input"]>(input: I, quotes: readonly StoredQuote[]): I | (I & { text: string }) {
  if (quotes.length === 0) return input;
  const message = input.message ?? input.text ?? "";
  const note = joinNotes(input.note ?? "", quotesNote(quotes));
  return { ...input, text: withAttachmentsNote(note, message), note, message, quotes: [...quotes] };
}
