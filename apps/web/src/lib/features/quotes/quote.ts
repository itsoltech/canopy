import { isQuoteSourceKind, type QuoteSourceKind } from "@canopy/domain";
import type { ui } from "@canopy/contracts";

export function draftOf(quote: ui.Quote): QuoteDraft {
  return {
    ...quote,
    id: crypto.randomUUID(),
    sourceKind: isQuoteSourceKind(quote.sourceKind) ? quote.sourceKind : "agent_message",
  };
}

/** A quote waiting in a thread's composer draft (sent as SendMessage.quotes). */
export interface QuoteDraft {
  readonly id: string;
  readonly text: string;
  readonly comment: string;
  readonly sourceItemId: string;
  readonly sourceThreadId: string;
  readonly sourceKind: QuoteSourceKind;
  readonly language: string;
  readonly start?: number;
  readonly end?: number;
  readonly sourceAuthor?: string;
  readonly sourceTime?: string;
}

/** A quote as the BFF takes it (api/threads/[id]/messages, `quotes`); a type alias, so it fits a `JsonBody`. */
export type WireQuote = {
  readonly text: string;
  readonly comment?: string;
  readonly sourceItemId?: string;
  readonly sourceThreadId?: string;
  readonly sourceKind?: string;
  readonly language?: string;
  readonly start?: number;
  readonly end?: number;
  readonly sourceAuthor?: string;
  readonly sourceTime?: string;
};

export function toWire(quote: QuoteDraft): WireQuote {
  return {
    text: quote.text,
    ...(quote.comment.trim() && { comment: quote.comment.trim() }),
    ...(quote.sourceItemId && { sourceItemId: quote.sourceItemId }),
    ...(quote.sourceThreadId && { sourceThreadId: quote.sourceThreadId }),
    sourceKind: quote.sourceKind,
    ...(quote.language && { language: quote.language }),
    ...(quote.start !== undefined && { start: quote.start, end: quote.end }),
    ...(quote.sourceAuthor && { sourceAuthor: quote.sourceAuthor }),
    ...(quote.sourceTime && { sourceTime: quote.sourceTime }),
  };
}

/** The beginning of a quote for a chip: one line, whitespace collapsed, ellipsized past `max` characters. */
export function quoteLabel(text: string, max = 32): string {
  const line = text.replace(/\s+/g, " ").trim();

  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
}
