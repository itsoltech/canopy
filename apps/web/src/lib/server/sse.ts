/**
 * Server-Sent Events from a gRPC stream (docs/ui-api.md): one `data:` line of JSON per update,
 * a comment heartbeat to keep proxies from closing idle connections, and the upstream stream
 * aborted as soon as the browser goes away.
 */
export function sseResponse<T>(
  request: Request,
  source: (signal: AbortSignal) => AsyncIterable<T>,
  encode: (value: T) => unknown,
): Response {
  const upstream = new AbortController();
  request.signal.addEventListener("abort", () => upstream.abort(), { once: true });
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          upstream.abort(); // client gone
        }
      };
      const heartbeat = setInterval(() => send(": ping\n\n"), 15_000);
      try {
        for await (const value of source(upstream.signal)) send(`data: ${JSON.stringify(encode(value))}\n\n`);
      } catch (cause) {
        if (!upstream.signal.aborted) {
          console.error("event stream failed", cause);
          send(`event: failure\ndata: ${JSON.stringify({ message: "stream interrupted" })}\n\n`);
        }
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      upstream.abort();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
