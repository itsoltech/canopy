import type { ConsumedUsage } from "../token-usage.ts";
import { tokenFields } from "../token-usage.ts";
import { FrozenQuotes } from "./frozen-quotes.ts";
import type { ApiQuote } from "./model-rates.ts";

type Source = "raw" | "counter";

interface PendingQuote {
  key: string;
  quote: ApiQuote | undefined;
}

/** Match the two ordered usage streams before valuation, so a later duplicate cannot reprice a response. */
export class ResponseQuotes {
  readonly raw = new FrozenQuotes();
  readonly counter = new FrozenQuotes();
  readonly #pending: Record<Source, PendingQuote[]> = { raw: [], counter: [] };
  rawValid = true;

  add(source: Source, usage: ConsumedUsage, current: ApiQuote | undefined, valid = true): void {
    const other = source === "raw" ? "counter" : "raw";
    const key = tokenFields.map((field) => usage[field]).join("/");
    const index = valid ? this.#pending[other].findIndex((entry) => entry.key === key) : -1;
    const matched = index >= 0 ? this.#pending[other].splice(index, 1)[0] : undefined;
    const quote = matched ? matched.quote : current;

    if (!matched && valid) this.#pending[source].push({ key, quote });
    this[source].add(quote);

    if (source === "raw" && !quote) this.rawValid = false;
  }
}
