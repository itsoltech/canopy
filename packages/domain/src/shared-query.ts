/**
 * Reads shared by every consumer of one client session (docs/ui-api.md, "Współdzielone odczyty").
 *
 * A key names one request, e.g. `ListModels` or `GetAgentEnvironment`. Consumers watching the same key share
 * one value and one request in flight. Data changes only on known events: a stream event or a mutation
 * invalidates the key or sets its value, and a watched key reads again once per burst. A read started before
 * a newer value was set is discarded, and nothing finishes into a cache after `forget` or `dispose`.
 * Unwatched values stay for a later consumer in a bounded LRU.
 */
export type QuerySnapshot<T> = {
  /** The last value read or set. A failed read keeps it. */
  readonly data: T | undefined;
  /** A read succeeded or a value was set: an empty result is loaded too. */
  readonly loaded: boolean;
  readonly loading: boolean;
  /** Why the last read failed; cleared by the next success. */
  readonly error: string;
  /** Invalidated and not read again yet. */
  readonly stale: boolean;
};

export type QueryFetch<T> = (signal: AbortSignal) => Promise<T>;

type Listener = () => void;

type Match = string | ((key: string) => boolean);

type Entry = {
  key: string;
  fetch: QueryFetch<unknown>;
  snapshot: QuerySnapshot<unknown>;
  listeners: Set<Listener>;
  inflight: { promise: Promise<unknown>; controller: AbortController } | undefined;
  /** Grows with every `set`: a read started before it is older than the value. */
  written: number;
  /** When the value was last read or set (ms). */
  readAt: number;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/** `set` takes a value or an updater; protobuf messages and plain data are never functions. */
function isUpdater<T>(value: T | ((current: T | undefined) => T)): value is (current: T | undefined) => T {
  return value instanceof Function;
}

const EMPTY: QuerySnapshot<never> = { data: undefined, loaded: false, loading: false, error: "", stale: false };

export class QueryCacheDisposed extends Error {
  constructor() {
    super("The session ended");
  }
}

export type QueryCacheOptions = {
  /** Unwatched entries kept for later consumers (LRU). */
  idle?: number;
  /** Delay that merges a burst of invalidations into one read (ms). */
  coalesceMs?: number;
  /** User-facing text for a failed read. */
  failure?: (cause: unknown) => string;
};

export class QueryCache {
  readonly #entries = new Map<string, Entry>();
  readonly #idle: number;
  readonly #coalesceMs: number;
  readonly #failure: (cause: unknown) => string;
  #disposed = false;

  constructor({ idle = 48, coalesceMs = 40, failure }: QueryCacheOptions = {}) {
    this.#idle = idle;
    this.#coalesceMs = coalesceMs;
    this.#failure = failure ?? ((cause) => (cause instanceof Error ? cause.message : "Could not load"));
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  snapshot<T>(key: string): QuerySnapshot<T> {
    // SAFETY: An entry's value is only ever produced by the fetch or `set` of its own key, typed by the caller.
    return (this.#entries.get(key)?.snapshot ?? EMPTY) as QuerySnapshot<T>;
  }

  /** The value, read once and shared; a loaded, current entry answers without a request. */
  async read<T>(key: string, fetch: QueryFetch<T>): Promise<T> {
    if (this.#disposed) throw new QueryCacheDisposed();
    const entry = this.#entry(key, fetch);

    if (entry.snapshot.loaded && !entry.dirty) return this.snapshot<T>(key).data!;
    this.#touch(entry);

    return this.#load<T>(entry);
  }

  /**
   * Keeps the key current while watched. The listener runs on every change; returns the unsubscribe.
   * `maxAgeMs` bounds staleness for data some changes of which have no event: a new watcher of an older value
   * reads again.
   */
  watch<T>(key: string, fetch: QueryFetch<T>, listener: Listener, maxAgeMs = Infinity): () => void {
    if (this.#disposed) return () => {};

    const entry = this.#entry(key, fetch);
    entry.fetch = fetch;
    entry.listeners.add(listener);

    if (!entry.snapshot.loaded || entry.dirty || Date.now() - entry.readAt > maxAgeMs)
      void this.#load(entry).catch(() => {});

    return () => {
      entry.listeners.delete(listener);

      if (!entry.listeners.size) this.#touch(entry);
    };
  }

  /** A value from a mutation response or a pushed event. Reads already in flight are older and are dropped. */
  set<T>(key: string, value: T | ((current: T | undefined) => T)): void {
    if (this.#disposed) return;
    const entry = this.#entries.get(key) ?? this.#entry(key, () => Promise.reject(new Error(`No reader for ${key}`)));
    // SAFETY: The updater receives this key's value as its caller typed it.
    const current = entry.snapshot.data as T | undefined;
    const data = isUpdater(value) ? value(current) : value;
    entry.written++;
    entry.readAt = Date.now();
    entry.dirty = false;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    this.#publish(entry, { data, loaded: true, error: "", stale: false });
    this.#touch(entry);
  }

  /** Marks matching entries stale; watched ones read again once after the burst, the rest on next use. */
  invalidate(match: Match): void {
    for (const entry of this.#matching(match)) {
      entry.dirty = true;

      if (!entry.snapshot.stale) this.#publish(entry, { stale: true });

      if (!entry.listeners.size || entry.timer) continue;
      entry.timer = setTimeout(() => {
        entry.timer = undefined;

        if (this.#entries.get(entry.key) === entry && entry.dirty && !entry.inflight)
          void this.#load(entry).catch(() => {});
      }, this.#coalesceMs);
    }
  }

  /** Clears matching entries (unlink, removal); their reads in flight never land. Watched ones read again. */
  forget(match: Match): void {
    for (const entry of this.#matching(match)) {
      if (!entry.listeners.size) {
        this.#drop(entry);
        continue;
      }

      entry.inflight?.controller.abort();
      entry.inflight = undefined;
      entry.written++;
      this.#publish(entry, EMPTY);
      void this.#load(entry).catch(() => {});
    }
  }

  /** Ends the session: nothing reads or lands afterwards. */
  dispose(): void {
    this.#disposed = true;

    for (const entry of this.#entries.values()) this.#drop(entry);
  }

  #matching(match: Match): Entry[] {
    const matches = match instanceof Function ? match : (key: string) => key === match;

    return [...this.#entries.values()].filter((entry) => matches(entry.key));
  }

  #entry(key: string, fetch: QueryFetch<unknown>): Entry {
    const existing = this.#entries.get(key);

    if (existing) return existing;

    const entry: Entry = {
      key,
      fetch,
      snapshot: EMPTY,
      listeners: new Set(),
      inflight: undefined,
      written: 0,
      readAt: 0,
      dirty: false,
      timer: undefined,
    };

    this.#entries.set(key, entry);

    return entry;
  }

  #load<T>(entry: Entry): Promise<T> {
    if (entry.inflight) {
      // SAFETY: An entry only ever holds the result of its own key's fetch, typed by the caller of that key.
      return entry.inflight.promise as Promise<T>;
    }

    const controller = new AbortController();
    const written = entry.written;
    entry.dirty = false;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    this.#publish(entry, { loading: true });

    const promise = entry
      .fetch(controller.signal)
      .then(
        (data) => {
          if (!this.#current(entry, controller)) throw new QueryCacheDisposed();

          // A value set meanwhile is newer than this read.
          if (entry.written === written) {
            entry.readAt = Date.now();
            this.#publish(entry, { data, loaded: true, loading: false, error: "", stale: entry.dirty });
          } else this.#publish(entry, { loading: false });

          // SAFETY: The entry's value is this key's result (read now or set meanwhile).
          return entry.snapshot.data as T;
        },
        (cause: unknown) => {
          if (!this.#current(entry, controller)) throw new QueryCacheDisposed();
          this.#publish(entry, { loading: false, error: this.#failure(cause) });
          throw cause;
        },
      )
      .finally(() => {
        if (entry.inflight?.controller !== controller) return;
        entry.inflight = undefined;

        // Invalidated while reading: one trailing read for the consumers still watching.
        if (entry.dirty && entry.listeners.size && this.#entries.get(entry.key) === entry)
          void this.#load(entry).catch(() => {});
      });

    entry.inflight = { promise, controller };

    return promise;
  }

  #current(entry: Entry, controller: AbortController): boolean {
    return !this.#disposed && !controller.signal.aborted && this.#entries.get(entry.key) === entry;
  }

  #drop(entry: Entry): void {
    entry.inflight?.controller.abort();
    entry.inflight = undefined;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    this.#entries.delete(entry.key);
  }

  /** Most recently used last; unwatched entries beyond the limit are dropped oldest first. */
  #touch(entry: Entry): void {
    if (this.#entries.get(entry.key) !== entry) return;
    this.#entries.delete(entry.key);
    this.#entries.set(entry.key, entry);
    let idle = [...this.#entries.values()].filter((e) => !e.listeners.size && !e.inflight).length;

    for (const candidate of this.#entries.values()) {
      if (idle <= this.#idle) break;

      if (candidate.listeners.size || candidate.inflight || candidate === entry) continue;
      this.#drop(candidate);
      idle--;
    }
  }

  #publish(entry: Entry, patch: Partial<QuerySnapshot<unknown>>): void {
    entry.snapshot = { ...entry.snapshot, ...patch };

    for (const listener of entry.listeners) listener();
  }
}
