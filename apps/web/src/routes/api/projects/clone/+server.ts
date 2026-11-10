import { ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { CLONE_RPC_TIMEOUT_MS } from "@canopy/domain/clone-progress";
import { readMessage } from "#lib/server/body.ts";
import { gateway } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Request cancellation propagates through gRPC, including the linked computer route. */
export const POST: RequestHandler = async ({ request }) => {
  const input = await readMessage(request, ui.AddProjectRequestSchema);
  const controller = new AbortController();

  const iterator = gateway()
    .cloneProject(input, {
      signal: AbortSignal.any([request.signal, controller.signal]),
      timeoutMs: CLONE_RPC_TIMEOUT_MS,
    })
    [Symbol.asyncIterator]();

  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async pull(stream) {
        try {
          const next = await iterator.next();

          if (next.done) {
            stream.close();

            return;
          }

          stream.enqueue(
            encoder.encode(JSON.stringify({ event: encode(ui.CloneProjectUpdateSchema, next.value) }) + "\n"),
          );
        } catch (cause) {
          stream.enqueue(
            encoder.encode(
              JSON.stringify({
                error:
                  cause instanceof ConnectError ? cause.rawMessage : "Cloning failed. Check the connection and retry.",
              }) + "\n",
            ),
          );
          stream.close();
          controller.abort();
        }
      },
      async cancel() {
        controller.abort();
        await iterator.return?.();
      },
    }),
    { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" } },
  );
};
