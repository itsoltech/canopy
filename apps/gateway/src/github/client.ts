import { Code, ConnectError } from "@connectrpc/connect";
import { Option, Schema } from "effect";
import type { GitHubAccess } from "./access.ts";
import { GitHubHttpFailure } from "./http.ts";
import { reconnect, type AccountRow } from "./records.ts";
import type { BudgetRow, CacheRow } from "./store-cache.ts";
import { GitHubMemoryCache } from "./memory-cache.ts";

export interface GitHubRead {
  key: string;
  path: string;
  variables?: Readonly<Record<string, string | number>>;
  query?: string;
  ttl?: number;
  background?: boolean;
  project?: (value: Schema.JsonObject, headers: Headers) => Promise<Schema.JsonObject>;
}

/** Shared durable read cache and budget. Neither endpoint nor GraphQL text comes from a client. */
export class GitHubClient {
  readonly memory = new GitHubMemoryCache();
  #flights = new Map<string, Promise<CacheRow>>();
  #controllers = new Map<string, AbortController>();
  #stopped = false;
  constructor(readonly access: GitHubAccess) {}

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
    const { row } = await this.access.token(id);
    const cache = await this.cached(row, read.key);

    if (!force && cache?.payload && Number(new Date(cache.expires_at)) > this.access.http.now()) return cache;
    const key = `${id}:${row.revision}:${read.key}`;
    const old = this.#flights.get(key);

    if (old) return old;

    if (this.#stopped) throw new ConnectError("GitHub is reconnecting. Retry when connected.", Code.Unavailable);
    const controller = new AbortController();
    this.#controllers.set(key, controller);
    const promise = this.#load(row, read, controller.signal);
    this.#flights.set(key, promise);

    try {
      return await promise;
    } finally {
      this.#flights.delete(key);
      this.#controllers.delete(key);
    }
  }
  async #load(row: AccountRow, read: GitHubRead, signal: AbortSignal): Promise<CacheRow> {
    const { run, http } = this.access;
    const lease = Bun.randomUUIDv7();
    const deadline = Date.now() + 55_000;
    let previous = await this.cached(row, read.key);
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

      if (previous?.payload && BigInt(previous.generation) > generation) return previous;
      const response = await this.#request(row, read, previous?.etag ?? "", signal);

      const payload =
        response.value && read.project
          ? await read.project(response.value, response.headers)
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
