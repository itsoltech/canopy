import { create } from "@bufbuild/protobuf";
import { ui } from "@open-agents/contracts";

/** A quote of a message (SendMessage.quotes) as kept in the turn's or steer's input JSON. */
export interface StoredQuote {
  text: string;
  comment?: string;
  sourceItemId?: string;
  sourceThreadId?: string;
  sourceKind?: string;
  language?: string;
}

export function toUiQuote(quote: StoredQuote): ui.Quote {
  return create(ui.QuoteSchema, {
    text: quote.text,
    comment: quote.comment ?? "",
    sourceItemId: quote.sourceItemId ?? "",
    sourceThreadId: quote.sourceThreadId ?? "",
    sourceKind: quote.sourceKind ?? "",
    language: quote.language ?? "",
  });
}
