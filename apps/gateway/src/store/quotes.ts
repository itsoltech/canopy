import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { PullRequestCitation } from "@canopy/domain";

/** A quote of a message (SendMessage.quotes) as kept in the turn's or steer's input JSON. */
export interface StoredQuote {
  text: string;
  comment?: string;
  sourceItemId?: string;
  sourceThreadId?: string;
  sourceKind?: string;
  language?: string;
  start?: number;
  end?: number;
  sourceAuthor?: string;
  sourceTime?: string;
  pullRequest?: PullRequestCitation;
}

export function toUiQuote(quote: StoredQuote): ui.Quote {
  return create(ui.QuoteSchema, {
    text: quote.text,
    comment: quote.comment ?? "",
    sourceItemId: quote.sourceItemId ?? "",
    sourceThreadId: quote.sourceThreadId ?? "",
    sourceKind: quote.sourceKind ?? "",
    language: quote.language ?? "",
    start: quote.start,
    end: quote.end,
    sourceAuthor: quote.sourceAuthor ?? "",
    sourceTime: quote.sourceTime ?? "",
    pullRequest: quote.pullRequest,
  });
}
