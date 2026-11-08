import { NativeModule, requireNativeModule } from "expo";
import { ProbeError, type PinnedTransport } from "./routes";
import { streamResponse } from "./stream-response";

type ResponseEvent = { id: string; status: number; headers: Record<string, string>; fingerprint: string };

type DataEvent = { id: string; data: string };

type EndEvent = { id: string };

type ErrorEvent = { id: string; kind: string; message: string; code?: string };

type Events = {
  onResponse: (event: ResponseEvent) => void;
  onData: (event: DataEvent) => void;
  onEnd: (event: EndEvent) => void;
  onError: (event: ErrorEvent) => void;
};

declare class PinnedModule extends NativeModule<Events> {
  start(
    id: string,
    url: string,
    method: string,
    headers: Record<string, string>,
    body: Uint8Array | null,
    pin: string,
  ): Promise<void>;
  cancel(id: string): void;
  reset(): void;
  cancelProbe(id: string): void;
  probe(
    host: string,
    port: number,
    pin: string,
    timeoutMs: number,
    id: string,
  ): Promise<{ ok: boolean; fingerprint?: string; code?: string; kind?: string }>;
}

const native = requireNativeModule<PinnedModule>("CanopyPinnedFetch");
let sequence = 0;

/** Every watched stream starts with a snapshot, which brings its headers; none in this time means a dead connection. */
const STREAM_RESPONSE_TIMEOUT = 40_000;
const PROBE_TIMEOUT = 2000;

/** Streaming Fetch adapter for Connect. TLS pinning runs natively before request bytes leave the phone. */
function fetchPinned(url: string, init: RequestInit | undefined, fingerprint: string): Promise<Response> {
  const id = `canopy-${++sequence}`;
  init?.signal?.throwIfAborted();
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const body = init?.body;
  const bytes = body instanceof Uint8Array ? body : null;

  if (body && !(body instanceof Uint8Array)) throw new Error("Pinned Connect requests require binary protobuf.");

  return new Promise((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let finished = false;
    const subscriptions: { remove(): void }[] = [];

    const cleanup = () => {
      finished = true;
      clearTimeout(waiting);
      init?.signal?.removeEventListener("abort", abort);

      for (const subscription of subscriptions) subscription.remove();
    };

    const fail = (error: Error) => {
      if (finished) return;
      cleanup();
      native.cancel(id);
      controller.error(error);
      reject(error);
    };

    const abort = () => fail(new Error("Request canceled"));

    // Only a stream is safe to give up on early: unary calls may run long, and they are never replayed anyway.
    const streaming = headers["content-type"]?.startsWith("application/connect+");

    const waiting = streaming
      ? setTimeout(() => fail(new ProbeError("timeout", withCode(UNREACHABLE, "timeout"))), STREAM_RESPONSE_TIMEOUT)
      : undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel() {
        if (!finished) {
          cleanup();
          native.cancel(id);
        }
      },
    });

    subscriptions.push(
      native.addListener("onResponse", (event) => {
        if (event.id !== id || finished) return;

        if (event.fingerprint && event.fingerprint !== fingerprint) {
          fail(new ProbeError("pin", PIN_CHANGED));

          return;
        }

        clearTimeout(waiting);
        resolve(streamResponse(stream, event));
      }),
      native.addListener("onData", (event) => {
        if (event.id === id && !finished) controller.enqueue(Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0)));
      }),
      native.addListener("onEnd", (event) => {
        if (event.id !== id || finished) return;
        cleanup();
        controller.close();
      }),
      native.addListener("onError", (event) => {
        if (event.id === id) fail(failure(event));
      }),
    );
    init?.signal?.addEventListener("abort", abort, { once: true });

    if (init?.signal?.aborted) {
      abort();

      return;
    }

    void native
      .start(id, url, init?.method ?? "POST", headers, bytes, fingerprint)
      .catch(() => fail(new Error("Could not start secure request.")));
  });
}

const PIN_CHANGED = "Computer certificate changed. Pair this phone again.";

const UNREACHABLE = "Could not connect to this computer. Check the network, then try again.";

/** The native domain and code stay in the text, so a screenshot is enough to diagnose a failure. */
const withCode = (text: string, code?: string) => (code ? `${text} (${code})` : text);

function failure(event: ErrorEvent) {
  if (event.kind === "pin") return new ProbeError("pin", PIN_CHANGED);

  return new ProbeError(
    event.code ?? "unknown",
    withCode(event.kind === "io" ? "Connection interrupted. Try again." : UNREACHABLE, event.code),
  );
}

export const pinnedTransport: PinnedTransport = {
  async probe(origin, fingerprint, signal, timeoutMs = PROBE_TIMEOUT) {
    signal?.throwIfAborted();
    const url = new URL(origin);
    const id = `probe-${++sequence}`;
    const abort = () => native.cancelProbe(id);
    signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;

    // The native timeout covers connect and handshake; this one also covers a name lookup that never ends.
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProbeError("timeout")), timeoutMs);
    });

    const result = await Promise.race([
      native.probe(url.hostname.replace(/^\[|\]$/g, ""), Number(url.port || 443), fingerprint, timeoutMs, id),
      late,
    ]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      native.cancelProbe(id);
    });

    signal?.throwIfAborted();

    if (!result.ok || result.fingerprint !== fingerprint)
      throw new ProbeError(result.ok || result.kind === "pin" ? "pin" : (result.code ?? "unknown"));
  },
  fetch: fetchPinned,
  reset: () => native.reset(),
};
