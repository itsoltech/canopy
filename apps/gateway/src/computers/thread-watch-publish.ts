import { create, type Message } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { ConnectError } from "@connectrpc/connect";
import { cursorOf, type Clock } from "./mirror.ts";
import type { RemoteServe } from "./remote.ts";
import type { LinkedComputers } from "./runtime.ts";
import { watchTiming } from "./watch-liveness.ts";

/** The durable revision probe does not depend on Hub fan-out or on an HTTP/2 pong. */
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
  let probing = false;

  const probe = async () => {
    if (probing || combined.aborted) return;
    probing = true;

    try {
      const clock = (
        await computers.store.query<Clock>(
          "SELECT epoch,revision::text FROM computer_thread_clock WHERE owner_user_id=$1::uuid",
          [computers.store.owner],
        )
      )[0];

      if (clock && !combined.aborted) output.push(create(ui.ThreadUpdateSchema, { watchCursor: cursorOf(clock) }));
    } catch {
      if (!combined.aborted)
        console.warn("Linked thread revision probe failed", { peer, threadId: request.threadId, side: "home" });
      output.close(new Error("Linked thread revision probe failed"));
    } finally {
      probing = false;
    }
  };

  const timer = setInterval(() => {
    void probe();
  }, watchTiming(computers).heartbeatMs);

  timer.unref();
  console.debug("Linked thread watch subscribed", {
    peer,
    threadId: request.threadId,
    side: "home",
    resuming: Boolean(request.cursor || request.mirrorCursor),
  });

  const reading = (async () => {
    try {
      for await (const update of serve(ui.GatewayService.method.watchThread, request, combined, peer))
        if (!output.push(update)) break;
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
    clearInterval(timer);
    stopped.abort();
    combined.removeEventListener("abort", close);
    await reading;
    console.debug("Linked thread watch ended", { peer, threadId: request.threadId, side: "home" });
  }
}
