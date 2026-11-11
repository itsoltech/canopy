import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import { redactConnector } from "../connectors/oauth.ts";

export interface GitHubOptions {
  readonly clientId?: string;
  readonly slug?: string;
  /** In-process fixture injection only; endpoint origins are never configurable by clients. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export function githubConfig(options: GitHubOptions = {}) {
  const clientId = options.clientId ?? process.env["CANOPY_GITHUB_APP_CLIENT_ID"] ?? "Iv23liqSybfDzvusCyjP";
  const slug = options.slug ?? process.env["CANOPY_GITHUB_APP_SLUG"] ?? "canopy-by-it-sol";

  return { clientId, slug, configured: /^[A-Za-z0-9_.-]{1,100}$/.test(clientId) && /^[a-z0-9-]{1,100}$/.test(slug) };
}

export class GitHubHttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly retryAt: number,
  ) {
    super("GitHub request failed");
  }
}

/** Bound the decoded response before JSON parsing; never retain vendor error bodies. */
async function bodyText(response: Response) {
  const reader = response.body?.getReader();

  if (!reader) throw new Error("Empty GitHub response");
  let size = 0;
  const parts: Uint8Array[] = [];

  try {
    for (;;) {
      const part = await reader.read();

      if (part.done) break;
      size += part.value.byteLength;

      if (size > 2 * 1024 * 1024) throw new Error("GitHub response exceeds limit");
      parts.push(part.value);
    }
  } finally {
    await reader.cancel();
  }

  return Buffer.concat(parts).toString("utf8");
}

export class GitHubHttp {
  readonly config;
  readonly now;
  #fetch;
  constructor(options: GitHubOptions = {}) {
    this.config = githubConfig(options);
    this.#fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }
  async request(path: string, init: RequestInit, secrets: readonly string[] = []) {
    const origin = path.startsWith("/login/") ? "https://github.com" : "https://api.github.com";

    const response = await this.#fetch(`${origin}${path}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(15_000)]),
      headers: { Accept: "application/json", "X-GitHub-Api-Version": "2022-11-28", ...init.headers },
    });

    if (!response.ok) {
      await response.body?.cancel();
      const retry = Number(response.headers.get("retry-after"));
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;

      const limited =
        response.status === 429 ||
        (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || retry > 0));

      throw new GitHubHttpFailure(response.status, limited ? Math.max(this.now() + (retry || 60) * 1000, reset) : 0);
    }

    const text = await bodyText(response);

    return Schema.decodeUnknownSync(Schema.JsonObject)(
      JSON.parse(secrets.length ? redactConnector(text, {}, secrets) : text),
    );
  }
  post(path: string, fields: Record<string, string>) {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  }
  get(path: string, token: string, signal?: AbortSignal, secrets: readonly string[] = []) {
    return this.request(path, { headers: { Authorization: `Bearer ${token}` }, ...(signal && { signal }) }, [
      token,
      ...secrets,
    ]);
  }
}

export function githubFailure(cause: unknown): ConnectError {
  if (cause instanceof ConnectError) return cause;

  if (cause instanceof GitHubHttpFailure && cause.retryAt)
    return new ConnectError(
      `GitHub's request limit is reached. Retry after ${new Date(cause.retryAt).toLocaleTimeString("en-US")}.`,
      Code.ResourceExhausted,
    );

  if (cause instanceof GitHubHttpFailure && [403, 404].includes(cause.status))
    return new ConnectError(
      "GitHub access is unavailable. Check the installation and repository permissions.",
      Code.PermissionDenied,
    );

  return new ConnectError("Could not reach GitHub. Check the connection, then retry.", Code.Unavailable);
}
