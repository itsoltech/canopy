import { createSubscriber } from "svelte/reactivity";
import type { DescMessage, MessageShape } from "@bufbuild/protobuf";
import { QueryCache, type QueryFetch, type QuerySnapshot } from "@canopy/domain/shared-query";
import { requestJson } from "./http.ts";
import { decode } from "./wire.ts";

/**
 * One shared read of the tab's QueryCache (docs/ui-api.md, "Współdzielone odczyty"). It is watched while an effect
 * or template reads it, so several components share one value and one request; events invalidate it centrally.
 */
export class SharedRead<T> {
  readonly #subscribe: () => void;

  constructor(
    private readonly queries: QueryCache,
    readonly key: string,
    private readonly fetch: QueryFetch<T>,
  ) {
    this.#subscribe = createSubscriber((update) => queries.watch(key, fetch, update));
  }

  get snapshot(): QuerySnapshot<T> {
    this.#subscribe();

    return this.queries.snapshot<T>(this.key);
  }

  get data(): T | undefined {
    return this.snapshot.data;
  }

  /** Reads again now (after a mutation or Retry); joins a read already running. */
  async reload(): Promise<T> {
    this.queries.invalidate(this.key);

    return this.queries.read(this.key, this.fetch);
  }

  /** A newer value from a mutation response. */
  set(value: T): void {
    this.queries.set(this.key, value);
  }
}

/** A GET of the BFF decoded into its message. */
export const getMessage =
  <D extends DescMessage>(schema: D, path: string): QueryFetch<MessageShape<D>> =>
  async () =>
    decode(schema, await requestJson("GET", path));

/** The tab's shared reads. The SPA serves one owner per tab; a new gateway or sign-in reloads the page. */
export const queries = new QueryCache();

/** A shared read of the BFF path. Route loads and components of the tab share one value and one request. */
export function sharedRead<D extends DescMessage>(key: string, schema: D, path: string): SharedRead<MessageShape<D>> {
  return new SharedRead(queries, key, getMessage(schema, path));
}

const revalidating = new Map<string, { users: number; stop: () => void }>();

/**
 * A bounded fallback for a shared read some changes of which send no event: while anyone asks for it, the key is
 * read again every `everyMs` while the page is visible (one timer per key, however many components ask).
 */
export function revalidateEvery(key: string, everyMs: number): () => void {
  const current = revalidating.get(key);

  if (current) current.users++;
  else {
    const timer = setInterval(() => {
      if (!document.hidden) queries.invalidate(key);
    }, everyMs);

    revalidating.set(key, { users: 1, stop: () => clearInterval(timer) });
  }

  return () => {
    const entry = revalidating.get(key);

    if (!entry || --entry.users > 0) return;
    entry.stop();
    revalidating.delete(key);
  };
}
