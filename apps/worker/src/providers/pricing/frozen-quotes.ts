import { rateHash, type ApiQuote } from "./model-rates.ts";

/** Bounded provenance for cumulative snapshots, including turns that span catalog refreshes. */
export class FrozenQuotes {
  #known = true;
  #usd: number | undefined;
  readonly #versions = new Set<string>();
  #overflow = "";

  add(quote: ApiQuote | undefined): void {
    if (!quote) {
      this.#known = false;

      return;
    }

    this.#usd = (this.#usd ?? 0) + quote.usd;

    if (this.#versions.size < 16 || this.#versions.has(quote.version)) this.#versions.add(quote.version);
    else this.#overflow = rateHash(`${this.#overflow}\n${quote.version}`);
  }

  get usd(): number | undefined {
    return this.#known && Number.isFinite(this.#usd) ? this.#usd : undefined;
  }

  get version(): string | undefined {
    return this.#versions.size
      ? JSON.stringify({ quotes: [...this.#versions].sort(), overflow: this.#overflow || undefined })
      : undefined;
  }
}
