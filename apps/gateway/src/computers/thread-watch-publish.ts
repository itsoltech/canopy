import { create, type Message } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { ConnectError } from "@connectrpc/connect";
import { linkedMessage, type RemoteServe } from "./remote.ts";
import type { LinkedComputers } from "./runtime.ts";
import { watchTiming } from "./watch-liveness.ts";
import { threadWatchRevisions } from "../core/thread-watch-revisions.ts";

function checkpoint(update: ui.ThreadUpdate) {
  if (update.change.case === "snapshot") return update.change.value.cursor;

  if (update.change.case === "delta") return update.change.value.snapshot?.cursor;

  return undefined;
}

/** The local and linked revision probe is independent of Hub fan-out and HTTP/2 pongs. */
export async function* publishThreadWatch(
  computers: LinkedComputers,
  serve: RemoteServe,
  request: ui.WatchThreadRequest,
  signal: AbortSignal,
  peer: string,
): AsyncGenerator<Message> {
  const output = new AsyncChannel<Message>();
  const stopped = new AbortController();
  const combined = AbortSignal.any([signal, stopped.signal]);
  const close = () => output.close();
  combined.addEventListener("abort", close, { once: true });
  let unsubscribe: (() => void) | undefined;
  console.debug("Linked thread watch subscribed", {
    peer,
    threadId: request.threadId,
    side: "home",
    resuming: Boolean(request.cursor || request.mirrorCursor),
  });

  const reading = (async () => {
    try {
      for await (const update of serve(ui.GatewayService.method.watchThread, request, combined, peer)) {
        if (combined.aborted) break;
        const typed = linkedMessage(ui.ThreadUpdateSchema, update);

        const cursor = checkpoint(typed);

        if (cursor && !unsubscribe)
          unsubscribe = threadWatchRevisions(computers.store.runtime, computers.store.owner).subscribe(
            {
              thread: request.threadId,
              cursor,
              send: (watchCursor) => {
                if (!combined.aborted) output.push(create(ui.ThreadUpdateSchema, { watchCursor }));
              },
              fail: (error) => output.close(error),
            },
            watchTiming(computers).heartbeatMs,
          );

        if (!output.push(update)) break;
      }

      output.close();
    } catch (error) {
      if (!combined.aborted)
        console.warn("Linked thread watch failed", {
          peer,
          threadId: request.threadId,
          side: "home",
          code: ConnectError.from(error).code,
        });
      output.close(error);
    }
  })();

  try {
    if (combined.aborted) close();
    yield* output;
  } finally {
    unsubscribe?.();
    stopped.abort();
    combined.removeEventListener("abort", close);
    await reading;
    console.debug("Linked thread watch ended", { peer, threadId: request.threadId, side: "home" });
  }
}
