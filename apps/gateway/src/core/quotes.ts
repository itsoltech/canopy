import type { ui } from "@canopy/contracts";
import { QUOTE_LIMITS, isQuoteSourceKind, joinNotes, composeQuotes, withAttachmentsNote } from "@canopy/domain";
import type { StoredQuote } from "../store/quotes.ts";
import type { TurnRow } from "../store/store.ts";
import type { GatewayCore } from "./core.ts";
import { coreState, InvalidError } from "./core-context.ts";
import { coreRun } from "./core-broadcast.ts";
import type { Mention } from "@canopy/contracts";
import { resolvePullRequestCitation } from "../github/citations.ts";

const MAX_ID = 200;

/**
 * The quotes of a message, checked (docs/ui-api.md, "Cytaty"): within the limits, non-empty text, a known source
 * kind. The source ids are kept as given: they only point the UI back to the quoted item.
 */
export function checkedQuotes(
  quotes: readonly ui.Quote[],
  invalid: (message: string) => Error,
  text?: string,
  mentions: readonly Mention[] = [],
): StoredQuote[] {
  if (quotes.length > QUOTE_LIMITS.maxQuotes)
    throw invalid(`up to ${QUOTE_LIMITS.maxQuotes} quotes can go with one message`);

  let end = 0;

  return [...quotes]
    .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity))
    .map((quote, index) => {
      const label = `quote ${index + 1}`;

      if (!quote.text.trim()) throw invalid(`${label} is empty`);

      if (quote.text.length > QUOTE_LIMITS.maxTextChars)
        throw invalid(`${label} is longer than ${QUOTE_LIMITS.maxTextChars} characters`);

      if (quote.comment.length > QUOTE_LIMITS.maxCommentChars)
        throw invalid(`the comment on ${label} is longer than ${QUOTE_LIMITS.maxCommentChars} characters`);

      if (quote.sourceKind && !isQuoteSourceKind(quote.sourceKind))
        throw invalid(`${label} has an unknown source kind "${quote.sourceKind}"`);

      if ((quote.sourceKind === "pull_request") !== Boolean(quote.pullRequest))
        throw invalid(`${label} has an invalid pull request source`);

      if (quote.sourceItemId.length > MAX_ID || quote.sourceThreadId.length > MAX_ID || quote.language.length > 40)
        throw invalid(`${label} has an invalid source`);

      if ((quote.start === undefined) !== (quote.end === undefined)) throw invalid(`${label} has an incomplete range`);

      if (quote.start !== undefined && quote.end !== undefined) {
        if (quote.start < end || quote.end <= quote.start || (text !== undefined && quote.end > text.length))
          throw invalid(`${label} has an invalid range`);
        end = quote.end;

        if (mentions.some((m) => m.start < quote.end! && m.end > quote.start!))
          throw invalid("a citation overlaps a mention");
      }

      return {
        text: quote.text,
        ...(quote.comment.trim() && { comment: quote.comment.trim() }),
        ...(quote.sourceItemId && { sourceItemId: quote.sourceItemId }),
        ...(quote.sourceThreadId && { sourceThreadId: quote.sourceThreadId }),
        ...(quote.sourceKind && { sourceKind: quote.sourceKind }),
        ...(quote.language && { language: quote.language }),
        ...(quote.start !== undefined && quote.end !== undefined && { start: quote.start, end: quote.end }),
        ...(quote.sourceAuthor && { sourceAuthor: quote.sourceAuthor.slice(0, 200) }),
        ...(quote.sourceTime && { sourceTime: quote.sourceTime.slice(0, 100) }),
        ...(quote.pullRequest && { pullRequest: quote.pullRequest }),
      };
    });
}

export async function coreCheckQuoteSources(core: GatewayCore, quotes: StoredQuote[], thread: string): Promise<void> {
  for (const quote of quotes) {
    if (quote.pullRequest) {
      Object.assign(quote, await resolvePullRequestCitation(core, thread, quote));
      continue;
    }

    if (!quote.sourceThreadId) continue;
    const source = await coreRun(core, (s) => s.thread(quote.sourceThreadId!)).catch(() => undefined);

    if (!source || source.owner_user_id !== core[coreState].options.userId)
      throw new InvalidError("citation source not found");
  }
}

/**
 * The input with the message's quotes: their note follows any other note (attachments), the user's text comes
 * last. Without quotes the input is unchanged.
 */
export function withQuotes<I extends TurnRow["input"]>(
  input: I,
  quotes: readonly StoredQuote[],
): I | (I & { text: string }) {
  if (quotes.length === 0) return input;
  const message = input.message ?? input.text ?? "";
  const composed = composeQuotes(message, [], quotes);
  const note = joinNotes(input.note ?? "", composed.note);

  return {
    ...input,
    text: note ? withAttachmentsNote(note, composed.message) : composed.message,
    note,
    message,
    quotes: [...quotes],
  };
}
