/**
 * agy passes its environment to run_command, including GEMINI_API_KEY. Give
 * each process a short-lived local key. Only the worker authenticates the
 * resulting Gemini model requests against the selected upstream.
 */
export function antigravityGeminiKey(apiKey: string, endpoint = "https://generativelanguage.googleapis.com") {
  const base = new URL(endpoint);

  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new Error("The Gemini API endpoint must be an HTTP(S) URL without credentials or query parameters.");
  const key = crypto.randomUUID();
  const closed = new AbortController();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request, listener) {
      if (request.headers.get("host") !== listener.url.host) return new Response(null, { status: 403 });

      if (request.headers.get("x-goog-api-key") !== key) return new Response(null, { status: 401 });
      const url = new URL(request.url);
      const model = /^\/v1(?:beta)?\/models\/[\w.-]+:(?:streamGenerateContent|generateContent|countTokens)$/u;

      if (request.method !== "POST" || !model.test(url.pathname)) return new Response(null, { status: 404 });
      const target = new URL(base.href);
      target.pathname = base.pathname.replace(/\/$/u, "") + url.pathname;

      if (url.searchParams.get("alt") === "sse") target.searchParams.set("alt", "sse");

      try {
        const response = await fetch(target, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: request.body,
          signal: AbortSignal.any([closed.signal, request.signal]),
          redirect: "error",
        });

        if (!response.ok) {
          await response.body?.cancel();

          return Response.json(
            { error: { code: response.status, message: `Gemini API request failed (HTTP ${response.status}).` } },
            { status: response.status },
          );
        }

        return new Response(response.body, {
          status: response.status,
          headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
        });
      } catch {
        return new Response("Gemini API request failed.", { status: 502 });
      }
    },
  });

  return {
    env: { GEMINI_API_KEY: key, GOOGLE_GEMINI_BASE_URL: server.url.origin },
    close() {
      closed.abort();

      return server.stop(true);
    },
  };
}
