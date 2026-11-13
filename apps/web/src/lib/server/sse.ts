import type { JsonValue } from "@bufbuild/protobuf";
import { syncMetrics, syncCpu, syncCpuMicros } from "@canopy/transport";
import { computerFailure } from "./gateway-errors.ts";
import { ConnectError } from "@connectrpc/connect";
import { bffMeasurements } from "./diagnostics.ts";
import { threadWatchFailure } from "@canopy/domain/thread-watch-recovery";

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
  const measured = bffMeasurements.enabled;
  const started = measured ? performance.now() : 0;
  let messages = 0;
  let bytesSent = 0;

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

            if (measured) bytesSent += bytes.length;

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
            if (measured && !messages++) bffMeasurements.record(8, performance.now() - started);
            const start = syncMetrics && syncCpu();

            if (upstream.signal.aborted || !send(`data: ${JSON.stringify(encode(value))}\n\n`, start)) break;
          }
        } catch (cause) {
          if (!upstream.signal.aborted) {
            const error = ConnectError.from(cause);

            const failure = threadWatchFailure(
              error.code,
              error.metadata.get("canopy-sync-reason") ?? "",
              computerFailure(cause),
              Number(error.metadata.get("canopy-frame-bytes")),
            );

            const code = failure.code;

            if (computerFailure(cause)) send(`event: away\ndata: ${JSON.stringify({ code, computer: true })}\n\n`);
            else {
              console.warn("Event stream failed", { code });
              send(`event: failure\ndata: ${JSON.stringify(failure)}\n\n`);
            }
          }
        } finally {
          if (measured) {
            bffMeasurements.record(9, performance.now() - started);
            bffMeasurements.record(10, messages);
            bffMeasurements.record(11, bytesSent);
          }

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
