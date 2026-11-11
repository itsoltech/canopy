import type { JsonValue } from "@bufbuild/protobuf";
import { syncMetrics, syncCpu, syncCpuMicros } from "@canopy/transport";
import { computerFailure } from "./gateway-errors.ts";
import { ConnectError } from "@connectrpc/connect";

const SSE_BUFFER_BYTES = 1024 * 1024;

/**
 * Server-Sent Events from a gRPC stream (docs/ui-api.md): one `data:` line of JSON per update,
 * a comment heartbeat to keep proxies from closing idle connections, and the upstream stream
 * aborted as soon as the browser goes away.
 */
export function sseResponse<T>(
  request: Request,
  source: (signal: AbortSignal) => AsyncIterable<T>,
  encode: (value: T) => JsonValue,
): Response {
  const upstream = new AbortController();
  const abort = () => upstream.abort();
  request.signal.addEventListener("abort", abort, { once: true });

  if (request.signal.aborted) abort();
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        const send = (text: string, start = syncMetrics && syncCpu()) => {
          try {
            const bytes = encoder.encode(text);

            // Permit one large snapshot, then terminate a reader that stops draining it.
            if ((controller.desiredSize ?? 0) <= 0) {
              controller.error(new Error("Event stream fell behind"));
              upstream.abort();

              return false;
            }

            if (start)
              syncMetrics?.record(
                "bff.sse.encode",
                bytes.length,
                syncCpuMicros(start),
                text.startsWith("event: heartbeat") ? "heartbeat" : "",
              );
            controller.enqueue(bytes);

            return true;
          } catch {
            upstream.abort(); // client gone

            return false;
          }
        };

        send("event: ready\ndata: {}\n\n");
        const heartbeat = setInterval(() => send("event: heartbeat\ndata: {}\n\n"), 10_000);

        try {
          for await (const value of source(upstream.signal)) {
            const start = syncMetrics && syncCpu();

            if (upstream.signal.aborted || !send(`data: ${JSON.stringify(encode(value))}\n\n`, start)) break;
          }
        } catch (cause) {
          if (!upstream.signal.aborted) {
            const code = ConnectError.from(cause).code;

            if (computerFailure(cause)) send(`event: away\ndata: ${JSON.stringify({ code, computer: true })}\n\n`);
            else {
              console.warn("Event stream failed", { code });
              send(`event: failure\ndata: ${JSON.stringify({ code, computer: false })}\n\n`);
            }
          }
        } finally {
          clearInterval(heartbeat);
          request.signal.removeEventListener("abort", abort);
          upstream.abort();

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
    },
    new ByteLengthQueuingStrategy({ highWaterMark: SSE_BUFFER_BYTES }),
  );

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
