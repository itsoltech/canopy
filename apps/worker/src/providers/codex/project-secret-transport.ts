import type { JsonValue } from "@canopy/domain";
import { decodeJson, isJsonObject, isString } from "../json.ts";

// The base URL belongs to a single configured inference provider. Never relay an
// arbitrary path, follow an upstream redirect, or send an unparsed model body.
const inferencePaths = new Set(["responses", "responses/compact", "memories/trace_summarize"]);

const hopHeaders = [
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export function codexModelPath(path: string): boolean {
  return inferencePaths.has(path);
}

/** Verified Codex versions use HTTP/SSE when the private relay rejects a WebSocket handshake with 426. */
export function codexResponsesHttpFallback(request: Request, path: string): Response | undefined {
  if (path === "responses" && request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket")
    return new Response(null, { status: 426 });

  return undefined;
}

export function redactCodexJson(value: JsonValue, redact: (text: string) => string): JsonValue {
  if (isString(value)) return redact(value);

  if (Array.isArray(value)) return value.map((item) => redactCodexJson(item, redact));

  if (isJsonObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactCodexJson(item, redact)]));

  return value;
}

function relayHeaders(source: Headers) {
  const headers = new Headers(source);

  for (const name of source.get("connection")?.split(",") ?? []) headers.delete(name.trim());

  for (const name of hopHeaders) headers.delete(name);

  return headers;
}

export async function redactModelRequest(
  request: Request,
  upstream: URL,
  path: string,
  redact: (text: string) => string,
  admits: () => Promise<boolean>,
): Promise<Response> {
  if (request.method !== "POST" || !codexModelPath(path)) return new Response(null, { status: 404 });

  if (request.headers.get("content-encoding") || request.headers.get("upgrade"))
    return new Response(null, { status: 415 });

  try {
    const incoming = decodeJson(await request.json());

    if (!isJsonObject(incoming)) return new Response(null, { status: 400 });

    if (!(await admits())) return new Response(null, { status: 409 });
    const body = JSON.stringify(redactCodexJson(incoming, redact));
    const headers = relayHeaders(request.headers);
    headers.set("accept-encoding", "identity");
    const url = new URL(path, upstream);
    url.search = new URL(request.url).search;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: request.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();

      return new Response(null, { status: 502 });
    }

    return new Response(response.body, {
      status: response.status,
      headers: relayHeaders(response.headers),
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
