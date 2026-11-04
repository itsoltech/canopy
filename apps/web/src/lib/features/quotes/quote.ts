import type { QuoteSourceKind } from "@canopy/domain";

/** A quote waiting in a thread's composer draft (sent as SendMessage.quotes). */
export interface QuoteDraft {
  readonly id: string;
  readonly text: string;
  readonly comment: string;
  readonly sourceItemId: string;
  readonly sourceThreadId: string;
  readonly sourceKind: QuoteSourceKind;
  readonly language: string;
}

/** A quote as the BFF takes it (api/threads/[id]/messages, `quotes`). */
export interface WireQuote {
  readonly text: string;
  readonly comment?: string;
  readonly sourceItemId?: string;
  readonly sourceThreadId?: string;
  readonly sourceKind?: string;
  readonly language?: string;
}

export function toWire(quote: QuoteDraft): WireQuote {
  return {
    text: quote.text,
    ...(quote.comment.trim() && { comment: quote.comment.trim() }),
    ...(quote.sourceItemId && { sourceItemId: quote.sourceItemId }),
    ...(quote.sourceThreadId && { sourceThreadId: quote.sourceThreadId }),
    sourceKind: quote.sourceKind,
    ...(quote.language && { language: quote.language }),
  };
}

/** The beginning of a quote for a chip: one line, whitespace collapsed, ellipsized past `max` characters. */
export function quoteLabel(text: string, max = 32): string {
  const line = text.replace(/\s+/g, " ").trim();

  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
}
