import { Code, ConnectError } from "@connectrpc/connect";
import { Effect, Metric, Option, Schema } from "effect";
import { githubMetrics } from "./metrics.ts";
import type { GitHubAccess } from "./access.ts";
import { GitHubHttpFailure } from "./http.ts";
import { reconnect, type AccountRow } from "./records.ts";
import type { BudgetRow, CacheRow } from "./store-cache.ts";
import { GitHubMemoryCache } from "./memory-cache.ts";
import { addAbortListener } from "node:events";

class CacheReadTimeout extends ConnectError {
  constructor() {
    super("Loading GitHub data timed out. Try again.", Code.Unavailable);
  }
}

async function waitForRead<T>(reading: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = Promise.withResolvers<never>();
  const listener = addAbortListener(signal, () => aborted.reject(signal.reason));

  try {
    const value = await Promise.race([reading, aborted.promise]);
    signal.throwIfAborted();

    return value;
  } finally {
    listener[Symbol.dispose]();
  }
}

export interface GitHubRead {
  key: string;
  path: string;
  image?: boolean;
  variables?: Readonly<Record<string, string | number>>;
  query?: string;
  ttl?: number;
  background?: boolean;
  signal?: AbortSignal;
  project?: (value: Schema.JsonObject, headers: Headers) => Promise<Schema.JsonObject>;
}

/** Shared durable read cache and budget. Neither endpoint nor GraphQL text comes from a client. */
export class GitHubClient {
  readonly memory = new GitHubMemoryCache();
  #flights = new Map<string, Promise<CacheRow>>();
  #controllers = new Map<string, AbortController>();
  #stopped = false;
  constructor(
    readonly access: GitHubAccess,
    readonly readTimeoutMs = 55_000,
  ) {}

  abort(id: string) {
    this.memory.clear(`${this.access.owner}:${id}:`);

    for (const [key, controller] of this.#controllers) if (key.startsWith(`${id}:`)) controller.abort();
  }
  async stop() {
    this.#stopped = true;
    this.memory.clear();

    for (const controller of this.#controllers.values()) controller.abort();
    await Promise.allSettled(this.#flights.values());
  }
  async cached(row: AccountRow, key: string) {
    const scope = `${row.owner_user_id}:${row.id}:${row.revision}:${key}`;
    const saved = (await this.access.run((s) => s.cacheRead(row, key)))[0];

    if (!saved) {
      this.memory.clear(scope);

      return undefined;
    }

    return { ...saved, payload: this.memory.read(scope, BigInt(saved.generation), saved.serialized_payload) };
  }
  async read(id: string, read: GitHubRead, force = false): Promise<CacheRow> {
    const started = performance.now();

    try {
      const value = await this.#read(id, read, force);
      await Effect.runPromise(Metric.update(githubMetrics.bytes, Buffer.byteLength(JSON.stringify(value.payload))));

      return value;
    } finally {
      await Effect.runPromise(Metric.update(githubMetrics.latency, performance.now() - started));
    }
  }
  async #read(id: string, read: GitHubRead, force: boolean, retry = true): Promise<CacheRow> {
    const { row } = await this.access.token(id);
    // An explicit refresh must not join a normal read that can still return a fresh cached value.
    const key = `${id}:${row.revision}:${force ? "refresh" : "read"}:${read.key}`;
    const old = this.#flights.get(key);

    if (old) {
      try {
        return await (read.signal ? waitForRead(old, read.signal) : old);
      } catch (cause) {
        if (!(cause instanceof CacheReadTimeout) || !retry || this.#stopped || read.signal?.aborted) throw cause;

        // One bounded replacement fill; repeated timeouts must surface rather than retry forever.
        return this.#read(id, read, force, false);
      }
    }

    if (this.#stopped) throw new ConnectError("GitHub is reconnecting. Retry when connected.", Code.Unavailable);
    const controller = new AbortController();
    this.#controllers.set(key, controller);

    // Register before cache I/O: a delayed miss must not outlive the flight it should join.
    const promise = this.#boundedRead(row, read, force, controller);

    this.#flights.set(key, promise);

    try {
      return await promise;
    } finally {
      if (this.#flights.get(key) === promise) {
        this.#flights.delete(key);
        this.#controllers.delete(key);
      }
    }
  }
  async #boundedRead(row: AccountRow, read: GitHubRead, force: boolean, controller: AbortController) {
    const timer = setTimeout(() => controller.abort(new CacheReadTimeout()), this.readTimeoutMs);
    const signal = read.signal ? AbortSignal.any([controller.signal, read.signal]) : controller.signal;

    try {
      return await waitForRead(this.#cachedRead(row, read, force, signal), signal);
    } finally {
      clearTimeout(timer);
    }
  }
  async #cachedRead(row: AccountRow, read: GitHubRead, force: boolean, signal: AbortSignal): Promise<CacheRow> {
    const cache = await this.cached(row, read.key);
    signal.throwIfAborted();
    const hit = !force && cache?.payload && Number(new Date(cache.expires_at)) > this.access.http.now();
    await Effect.runPromise(Metric.update(hit ? githubMetrics.hits : githubMetrics.misses, 1));

    if (hit) return cache;

    return this.#load(row, read, force, signal);
  }
  async #load(row: AccountRow, read: GitHubRead, force: boolean, signal: AbortSignal): Promise<CacheRow> {
    const { run, http } = this.access;
    const lease = Bun.randomUUIDv7();
    const deadline = Date.now() + 55_000;
    let previous = await this.cached(row, read.key);
    signal.throwIfAborted();
    const generation = BigInt(previous?.generation ?? 0);

    while (!(await run((s) => s.cacheClaim(row, read.key, lease))).length) {
      signal.throwIfAborted();

      if (Date.now() > deadline) throw new ConnectError("GitHub is busy. Retry in a moment.", Code.Unavailable);
      await Bun.sleep(50);
      const next = await this.cached(row, read.key);

      if (next?.payload && BigInt(next.generation) > generation) return next;
    }

    try {
      previous = await this.cached(row, read.key);
      signal.throwIfAborted();

      // Another service may have filled the cache before this caller sampled its generation.
      if (
        previous?.payload &&
        (BigInt(previous.generation) > generation || (!force && Number(new Date(previous.expires_at)) > http.now()))
      )
        return previous;
      // Release the fenced SQL lease even if an upstream transport ignores cancellation.
      const response = await waitForRead(this.#request(row, read, previous?.etag ?? "", signal), signal);

      const payload =
        response.value && read.project
          ? await waitForRead(read.project(response.value, response.headers), signal)
          : (response.value ?? previous?.payload);

      if (!payload) throw new Error("GitHub returned no content");

      if (signal.aborted || response.row.revision !== row.revision) throw reconnect();
      await run((s) => s.cachePrune(row.owner_user_id, Buffer.byteLength(JSON.stringify(payload))));

      const saved = await run((s) =>
        s.cacheFinish(
          row,
          read.key,
          lease,
          payload,
          response.headers.get("etag") ?? previous?.etag ?? "",
          http.now(),
          Math.max(read.ttl ?? 60_000, (Number(response.headers.get("x-poll-interval")) || 0) * 1000),
        ),
      );

      if (!saved.length) throw reconnect();

      // SAFETY: the fenced finish above created this exact cache entry.
      return (await this.cached(row, read.key))!;
    } finally {
      await run((s) => s.cacheRelease(row, read.key, lease));
    }
  }
  async #request(row: AccountRow, read: GitHubRead, etag: string, signal: AbortSignal) {
    if (read.image) return { ...(await this.access.http.image(read.path, etag, signal)), row };
    const { run, http } = this.access;
    const resource = read.query ? "graphql" : "core";
    const lease = Bun.randomUUIDv7();
    const deadline = Date.now() + 30_000;

    while (!(await run((s) => s.apiClaim(row.github_user_id, lease)))) {
      signal.throwIfAborted();

      if (Date.now() > deadline) throw new ConnectError("GitHub is busy. Retry in a moment.", Code.Unavailable);
      await Bun.sleep(50);
    }

    try {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        const budget = await run((s) => s.budget(row.github_user_id, resource, http.now()));
        this.#available(budget, resource, read.background);

        try {
          const result = await this.access.authorized(row.id, (access) =>
            http.detailed(
              read.path,
              {
                method: read.query ? "POST" : "GET",
                signal,
                headers: {
                  Authorization: `Bearer ${access.token}`,
                  ...(read.query ? { "Content-Type": "application/json" } : etag ? { "If-None-Match": etag } : {}),
                },
                ...(read.query && { body: JSON.stringify({ query: read.query, variables: read.variables }) }),
              },
              [access.token, ...(access.secrets ?? [])],
            ),
          );

          await this.#account(
            row,
            resource,
            result.value.headers,
            result.value.value,
            budget,
            undefined,
            result.value.status === 304,
          );

          return { ...result.value, row: result.row };
        } catch (cause) {
          if (cause instanceof GitHubHttpFailure) {
            await this.#account(row, resource, cause.headers, null, budget, cause);

            if ([403, 404].includes(cause.status) && !cause.retryAt) {
              this.memory.clear();
              await run((s) => s.cacheInvalidate(row.owner_user_id, row.id));
            }

            if (cause.status < 500 || cause.retryAt) throw cause;
          } else if (cause instanceof ConnectError) throw cause;

          if (attempt >= 2 || signal.aborted)
            throw new ConnectError("Could not reach GitHub. Check the connection, then retry.", Code.Unavailable);
          await Bun.sleep(attempt === 0 ? 2000 : 8000);
        }
      }
    } finally {
      await run((s) => s.apiRelease(lease));
    }
  }
  #available(budget: BudgetRow, resource: string, background = false) {
    const now = this.access.http.now();
    const retry = Number(new Date(budget.retry_at));

    const exhausted =
      budget.remaining < budget.limit_count * (background ? 0.2 : 0.05) ||
      budget.used >= (resource === "graphql" ? 1500 : 1000);

    if (retry > now || exhausted)
      throw new GitHubHttpFailure(429, Math.max(retry, exhausted ? Number(new Date(budget.reset_at)) : 0));
  }
  async #account(
    row: AccountRow,
    resource: string,
    headers: Headers,
    value: Schema.JsonObject | null,
    budget: BudgetRow,
    failure?: GitHubHttpFailure,
    notModified = false,
  ) {
    const graph = Schema.decodeUnknownOption(
      Schema.Struct({
        data: Schema.Struct({
          rateLimit: Schema.Struct({ cost: Schema.Number, remaining: Schema.Number, resetAt: Schema.String }),
        }),
      }),
    )(value);

    const rate = Option.getOrUndefined(graph)?.data.rateLimit;
    const number = (name: string) => (headers.has(name) ? Number(headers.get(name)) : undefined);
    const now = this.access.http.now();

    const retry = failure?.retryAt
      ? Math.max(failure.retryAt, now + Math.min(900_000, 60_000 * 2 ** budget.failures) * (0.8 + Math.random() * 0.4))
      : undefined;

    await Effect.runPromise(
      Effect.all([
        Metric.update(githubMetrics.remaining, rate?.remaining ?? number("x-ratelimit-remaining") ?? budget.remaining),
        Metric.update(githubMetrics.backoff, Math.max(0, (retry ?? now) - now)),
      ]),
    );

    await this.access.run((s) =>
      s.budgetRecord(
        row.github_user_id,
        resource,
        {
          cost: rate?.cost ?? (notModified ? 0 : 1),
          remaining: rate?.remaining ?? number("x-ratelimit-remaining"),
          limit: number("x-ratelimit-limit"),
          reset: rate
            ? Date.parse(rate.resetAt)
            : number("x-ratelimit-reset")
              ? Number(headers.get("x-ratelimit-reset")) * 1000
              : undefined,
          retry,
          failed: !!failure?.retryAt,
        },
        now,
      ),
    );
  }
}
