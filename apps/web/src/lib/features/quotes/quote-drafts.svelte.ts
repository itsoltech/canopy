import { isQuoteSourceKind, QUOTE_LIMITS } from "@canopy/domain";
import { toWire, type QuoteDraft, type WireQuote } from "./quote.ts";
import type { QuoteSource } from "./selection.ts";
import type { ui } from "@canopy/contracts";

/**
 * The quotes of each thread's composer draft, for this tab (like the draft text, nothing is stored in the
 * browser). Cite inserts at the registered editor's caret. The editor serializes their ranges after each edit.
 * Within QUOTE_LIMITS: `add` refuses (undefined) past the maximum.
 *
 *   const quotes = useQuoteDrafts();
 *   quotes.list(threadId)                       // tokens, in text order
 *   quotes.add(threadId, { text, source, comment })
 *   quotes.edit(threadId, id, "comment")  /  quotes.remove(threadId, id)
 *   sendMessage(…, quotes.wire(threadId)); quotes.clear(threadId)
 */
export class QuoteDrafts {
  #byThread = $state.raw<ReadonlyMap<string, readonly QuoteDraft[]>>(new Map());
  #editors = new Map<string, (quote: QuoteDraft, edit: boolean) => void>();

  connect(threadId: string, insert: (quote: QuoteDraft, edit: boolean) => void): () => void {
    this.#editors.set(threadId, insert);
    const pending = this.list(threadId).filter((q) => q.start === undefined);

    for (const quote of pending) insert(quote, false);

    return () => {
      if (this.#editors.get(threadId) === insert) this.#editors.delete(threadId);
    };
  }

  place(threadId: string, quotes: readonly QuoteDraft[]): void {
    this.#set(threadId, quotes);
  }

  list(threadId: string): readonly QuoteDraft[] {
    return this.#byThread.get(threadId) ?? [];
  }

  get(threadId: string, id: string): QuoteDraft | undefined {
    return this.list(threadId).find((q) => q.id === id);
  }

  add(threadId: string, quote: { text: string; source: QuoteSource; comment?: string }): QuoteDraft | undefined {
    const current = this.list(threadId);

    if (current.length >= QUOTE_LIMITS.maxQuotes) return undefined;

    const draft: QuoteDraft = {
      id: crypto.randomUUID(),
      text: quote.text.slice(0, QUOTE_LIMITS.maxTextChars),
      comment: (quote.comment ?? "").slice(0, QUOTE_LIMITS.maxCommentChars),
      sourceItemId: quote.source.itemId,
      sourceThreadId: quote.source.threadId,
      sourceKind: quote.source.kind,
      language: quote.source.language,
      ...(quote.source.author && { sourceAuthor: quote.source.author }),
      ...(quote.source.time && { sourceTime: quote.source.time }),
      ...(quote.source.pullRequest && { pullRequest: quote.source.pullRequest }),
    };

    const insert = this.#editors.get(threadId);

    if (insert) insert(draft, true);
    else this.#set(threadId, [...current, draft]);

    return draft;
  }

  edit(threadId: string, id: string, comment: string): void {
    this.#set(
      threadId,
      this.list(threadId).map((q) =>
        q.id === id ? { ...q, comment: comment.slice(0, QUOTE_LIMITS.maxCommentChars) } : q,
      ),
    );
  }

  remove(threadId: string, id: string): void {
    this.#set(
      threadId,
      this.list(threadId).filter((q) => q.id !== id),
    );
  }

  clear(threadId: string): void {
    this.#set(threadId, []);
  }

  restore(threadId: string, quotes: readonly ui.Quote[]): void {
    this.#set(
      threadId,
      quotes.flatMap((quote) =>
        isQuoteSourceKind(quote.sourceKind)
          ? [{ ...quote, sourceKind: quote.sourceKind, id: crypto.randomUUID() }]
          : [],
      ),
    );
  }

  /** The draft's quotes for SendMessage (empty comments left out). */
  wire(threadId: string): WireQuote[] {
    return this.list(threadId).map(toWire);
  }

  #set(threadId: string, quotes: readonly QuoteDraft[]): void {
    const next = new Map(this.#byThread);

    if (quotes.length > 0) next.set(threadId, quotes);
    else next.delete(threadId);
    this.#byThread = next;
  }
}

const drafts = new QuoteDrafts();

/** The tab's quote drafts (one store for every thread page and composer). */
export function useQuoteDrafts(): QuoteDrafts {
  return drafts;
}

export { quoteLabel, toWire, type QuoteDraft, type WireQuote } from "./quote.ts";
