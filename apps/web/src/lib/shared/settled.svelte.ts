import { untrack } from "svelte";

/**
 * Follows `read` only once a new value has held for `ms`, so a value that flips and back within that time (a command
 * that ends a moment after it starts) never shows. The first value shows at once. Create during component init.
 */
export class Settled<T> {
  current: T;

  constructor(read: () => T, ms: number) {
    this.current = $state(untrack(read));

    $effect(() => {
      const next = read();
      const shown = untrack(() => this.current);

      if (Object.is(next, shown)) return;
      const timer = setTimeout(() => (this.current = next), ms);

      return () => clearTimeout(timer);
    });
  }
}
