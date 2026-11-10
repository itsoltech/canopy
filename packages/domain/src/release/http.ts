/** Public release metadata only. No credentials, including on redirects. */
export const RELEASE_CACHE_MS = 15 * 60_000;

export function secureReleaseUrl(value: string, allowHttpForTests = false): URL {
  const url = new URL(value);

  if (
    (url.protocol !== "https:" && !(allowHttpForTests && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Release downloads require HTTPS without embedded credentials");

  return url;
}

export class ReleaseHttpError extends Error {
  constructor(readonly status: number) {
    super(`Release server returned HTTP ${status}`);
  }
}

export class ReleaseRateLimit extends Error {
  constructor(readonly retryAt: number) {
    super(rateLimitMessage(retryAt));
  }
}

export const RATE_LIMIT_PREFIX = "GitHub is limiting update checks from this network.";
export const isRateLimitMessage = (message: string) => message.startsWith(RATE_LIMIT_PREFIX);

export function rateLimitMessage(retryAt: number): string {
  const time = new Date(retryAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  return `${RATE_LIMIT_PREFIX} Next check at ${time}.`;
}

interface Entry {
  text?: string;
  etag?: string | undefined;
  until: number;
  pending?: Promise<string> | undefined;
  error?: Error | undefined;
}

export interface ReleaseHttpOptions {
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  allowHttpForTests?: boolean;
  cacheMs?: number;
}

function resetAt(headers: Headers, now: number): number {
  const retry = headers.get("retry-after");
  const retryAt = retry === null ? 0 : /^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry);
  const reset = Number(headers.get("x-ratelimit-reset")) * 1000;

  return Math.max(now + 60_000, Number.isFinite(retryAt) ? retryAt : 0, Number.isFinite(reset) ? reset : 0);
}

/** A process shares successful bodies, in-flight reads and API-origin cooldowns across repositories. */
export class ReleaseHttp {
  private readonly entries = new Map<string, Entry>();
  private readonly limited = new Map<string, number>();
  constructor(readonly options: ReleaseHttpOptions = {}) {}

  text(url: string): Promise<string> {
    const target = secureReleaseUrl(url, this.options.allowHttpForTests);
    const now = (this.options.now ?? Date.now)();
    let entry = this.entries.get(url);

    if (entry?.pending) return entry.pending;

    if (entry && now < entry.until) {
      if (entry.error) return Promise.reject(entry.error);

      if (entry.text !== undefined) return Promise.resolve(entry.text);
    }

    const retryAt = this.limited.get(target.origin) ?? 0;

    if (now < retryAt) return Promise.reject(new ReleaseRateLimit(retryAt));
    entry ??= { until: 0 };
    this.entries.set(url, entry);
    const current = entry;
    current.pending = this.read(target, current)
      .catch((error: Error) => {
        current.error = error;
        current.until = (this.options.now ?? Date.now)() + (error instanceof ReleaseRateLimit ? 0 : 60_000);
        throw error;
      })
      .finally(() => {
        current.pending = undefined;
      });

    return current.pending;
  }

  private async read(target: URL, entry: Entry): Promise<string> {
    for (let redirects = 0; redirects < 6; redirects++) {
      const retryAt = this.limited.get(target.origin) ?? 0;

      if ((this.options.now ?? Date.now)() < retryAt) throw new ReleaseRateLimit(retryAt);
      const headers = new Headers({ accept: "application/json", "user-agent": "Canopy-Updates" });

      if (entry.etag) headers.set("if-none-match", entry.etag);

      const response = await (this.options.fetch ?? fetch)(target, {
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(20_000),
        headers,
      });

      const now = (this.options.now ?? Date.now)();

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();

        if (!location) throw new Error("Release redirect has no location");
        target = secureReleaseUrl(new URL(location, target).href, this.options.allowHttpForTests);
        continue;
      }

      const limited = response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");

      if ((response.status === 403 || response.status === 429) && (limited || response.status === 429)) {
        const retryAt = resetAt(response.headers, now);
        this.limited.set(target.origin, retryAt);
        await response.body?.cancel();
        throw new ReleaseRateLimit(retryAt);
      }

      if (response.status !== 304 && !response.ok) {
        await response.body?.cancel();
        throw new ReleaseHttpError(response.status);
      }

      if (response.status === 304 && entry.text === undefined) throw new Error("Release cache has no body for 304");
      const text = response.status === 304 ? entry.text! : await response.text();

      if (text.length > 32 * 1024 * 1024) throw new Error("Release metadata is too large");
      entry.text = text;
      entry.etag = response.headers.get("etag") ?? (response.status === 304 ? entry.etag : undefined);
      entry.until = now + (this.options.cacheMs ?? RELEASE_CACHE_MS);
      entry.error = undefined;

      return text;
    }

    throw new Error("Too many release redirects");
  }
}

export const releaseHttp = new ReleaseHttp();
