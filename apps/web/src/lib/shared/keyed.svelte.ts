import { SvelteMap } from "svelte/reactivity";

/**
 * Values by key for long live lists: a reader of one key reruns only when that key's value changes. A list that
 * follows a live index (hundreds of sidebar rows) then updates the rows that changed, while the index itself
 * changes on every event (docs/client-performance.md). `sync` from an `$effect.pre` placed before the list, so
 * rows read the new values in the same update.
 */
export class Keyed<T> {
  readonly #values = new SvelteMap<string, T>();
  // The last values without reactivity: comparing them must not subscribe the syncing effect to every key.
  readonly #known = new Map<string, T>();

  constructor(private readonly same: (a: T, b: T) => boolean) {}

  get(key: string): T | undefined {
    return this.#values.get(key);
  }

  sync(entries: Iterable<readonly [string, T]>): void {
    const seen = new Set<string>();

    for (const [key, value] of entries) {
      seen.add(key);
      const known = this.#known.get(key);

      if (known !== undefined && this.same(known, value)) continue;
      this.#known.set(key, value);
      this.#values.set(key, value);
    }

    for (const key of this.#known.keys()) {
      if (seen.has(key)) continue;
      this.#known.delete(key);
      this.#values.delete(key);
    }
  }
}
