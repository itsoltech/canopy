import { stripVTControlCharacters } from "node:util";
import { redactConnector } from "../connectors/oauth.ts";
import { GitHubHttpFailure } from "./http.ts";
import { fetchLogStorage, storageUrl } from "./log-storage.ts";

async function logText(response: Response, secrets: readonly string[]) {
  const reader = response.body?.getReader();

  if (!reader) throw new Error("Log not available");
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  let truncated = false;

  try {
    for (;;) {
      const next = await reader.read();

      if (next.done) break;
      const remaining = 8 * 1024 * 1024 - size;
      parts.push(decoder.decode(next.value.subarray(0, remaining), { stream: true }));
      size += next.value.length;

      if (size > 8 * 1024 * 1024) {
        truncated = true;
        break;
      }

      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    parts.push(decoder.decode());
  } finally {
    await reader.cancel();
  }

  const lines = parts.join("").split("\n");
  truncated ||= lines.length > 50_000;

  const clean = stripVTControlCharacters(lines.slice(0, 50_000).join("\n"))
    // oxlint-disable-next-line no-control-regex -- Log bytes are untrusted; remove terminal and C0/C1 controls before caching.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]")
    .replace(/(authorization\s*[:=]\s*(?:bearer|token)\s+)\S+/gi, "$1[redacted]");

  return { text: redactConnector(clean, {}, secrets), truncated };
}

/** API auth is used once. Storage redirects never carry headers, cookies or the signed URL back to callers. */
export async function jobLogHttp(
  path: string,
  init: RequestInit,
  secrets: readonly string[],
  apiFetch: typeof fetch,
  injectedFetch: typeof fetch | undefined,
  now: number,
) {
  const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(20_000)]);

  let response = await apiFetch(`https://api.github.com${path}`, {
    ...init,
    signal,
    redirect: "manual",
    credentials: "omit",
  });

  const headers = new Headers();

  for (const name of [
    "etag",
    "retry-after",
    "x-poll-interval",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
  ])
    if (response.headers.has(name)) headers.set(name, redactConnector(response.headers.get(name)!, {}, secrets));

  if (response.status === 304) return { status: 304, headers, value: null };

  if (!response.ok && ![301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel();

    const limited =
      response.status === 429 ||
      (response.status === 403 && (headers.has("retry-after") || headers.get("x-ratelimit-remaining") === "0"));

    throw new GitHubHttpFailure(
      response.status,
      limited ? now + Math.max(60, Number(headers.get("retry-after"))) * 1000 : 0,
      headers,
    );
  }

  for (let redirects = 0; [301, 302, 303, 307, 308].includes(response.status); redirects++) {
    const location = response.headers.get("location");
    await response.body?.cancel();

    if (!location || redirects >= 2) throw new Error("Log redirect unavailable");
    const target = storageUrl(location);
    response = injectedFetch
      ? await injectedFetch(target, {
          signal,
          redirect: "manual",
          credentials: "omit",
          headers: { Accept: "text/plain", "Accept-Encoding": "identity" },
        })
      : await fetchLogStorage(target, signal);
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Log not available");
  }

  const value = await logText(response, secrets);
  // Location is a credential and must never enter durable cache metadata or metrics.
  headers.delete("location");

  return { status: 200, headers, value };
}
