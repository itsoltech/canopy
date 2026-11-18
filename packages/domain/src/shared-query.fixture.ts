import { QueryCache, QueryCacheDisposed, type QueryCacheOptions } from "./shared-query.ts";

/** An event-loop checkpoint drains promise continuations without waiting for wall-clock time. */
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

class QueryClock {
  #now = 0;
  #nextId = 1;
  readonly #timers = new Map<number, { at: number; run: () => void }>();

  readonly now = () => this.#now;

  readonly schedule = (run: () => void, delay: number) => {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + delay, run });

    return () => {
      this.#timers.delete(id);
    };
  };

  async advance(ms: number): Promise<void> {
    await settle();
    const end = this.#now + ms;

    for (;;) {
      const next = [...this.#timers].sort((a, b) => a[1].at - b[1].at)[0];

      if (!next || next[1].at > end) break;
      this.#now = next[1].at;
      this.#timers.delete(next[0]);
      next[1].run();
      await settle();
    }

    this.#now = end;
  }
}

/** The regular query cache with an injected clock; no timers or Date globals are patched. */
export function queryCache(options: QueryCacheOptions = {}) {
  const clock = new QueryClock();

  return { cache: new QueryCache({ ...options, clock }), clock, QueryCacheDisposed };
}
