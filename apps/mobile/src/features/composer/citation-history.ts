import type { ui } from "@canopy/contracts";
import { citationPlaceholder } from "@canopy/domain";
import type { MessageValue } from "./message-value";

/** Native undo and plain-text paste can restore a marker after its range was removed. */
export class CitationHistory {
  #quotes = new Map<string, ui.Quote>();
  #snapshots = new Map<string, readonly ui.Quote[]>();

  remember(value: MessageValue): void {
    if (value.quotes?.length) this.#snapshots.set(value.text, value.quotes);

    for (const quote of value.quotes ?? []) {
      this.#quotes.set(citationPlaceholder(quote.text), quote);
    }

    while (this.#quotes.size > 60) this.#quotes.delete(this.#quotes.keys().next().value!);

    while (this.#snapshots.size > 60) this.#snapshots.delete(this.#snapshots.keys().next().value!);
  }

  restore(value: MessageValue): MessageValue {
    const snapshot = this.#snapshots.get(value.text);

    if (snapshot) return { ...value, quotes: snapshot };
    const quotes = [...(value.quotes ?? [])];

    for (const [marker, quote] of this.#quotes) {
      let at = value.text.indexOf(marker);

      while (at >= 0) {
        const end = at + marker.length;

        if (
          ![...value.mentions, ...quotes].some(
            (m) => m.start !== undefined && m.end !== undefined && m.start < end && m.end > at,
          )
        )
          quotes.push({ ...quote, start: at, end });
        at = value.text.indexOf(marker, end);
      }
    }

    return { ...value, quotes: quotes.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity)) };
  }

  clear(): void {
    this.#quotes.clear();
    this.#snapshots.clear();
  }
}
