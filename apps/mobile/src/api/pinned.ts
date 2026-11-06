import { NativeModule, requireNativeModule } from "expo";
import { ProbeError, type PinnedTransport } from "./routes";

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
  probe(
    host: string,
    port: number,
    pin: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; fingerprint?: string; code?: string }>;
}

const native = requireNativeModule<PinnedModule>("CanopyPinnedFetch");
let sequence = 0;

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
          fail(new Error(PIN_CHANGED));

          return;
        }

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
        if (event.id === id) fail(new Error(failure(event)));
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

/** The native domain and code stay in the text, so a screenshot is enough to diagnose a failure. */
const withCode = (text: string, code?: string) => (code ? `${text} (${code})` : text);

function failure(event: ErrorEvent) {
  if (event.kind === "pin") return PIN_CHANGED;

  if (event.kind === "io") return withCode("Connection interrupted. Try again.", event.code);

  return withCode("Could not connect to this computer. Check the network, then try again.", event.code);
}

/** React Native's Response constructor doesn't accept streams. Connect consumes body, arrayBuffer or json. */
function streamResponse(body: ReadableStream<Uint8Array>, event: ResponseEvent) {
  const response = new Response(null, { status: event.status, headers: event.headers });
  Object.defineProperty(response, "body", { value: body });
  response.arrayBuffer = async () => {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) break;
        size += value.byteLength;

        if (size > 32 * 1024 * 1024) throw new Error("Response is too large.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }

    const result = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result.buffer;
  };

  response.text = async () => new TextDecoder().decode(await response.arrayBuffer());
  response.json = async () => JSON.parse(await response.text());

  return response;
}

export const pinnedTransport: PinnedTransport = {
  async probe(origin, fingerprint, signal) {
    signal?.throwIfAborted();
    const url = new URL(origin);
    const result = await native.probe(url.hostname.replace(/^\[|\]$/g, ""), Number(url.port || 443), fingerprint, 2000);
    signal?.throwIfAborted();

    if (!result.ok || result.fingerprint !== fingerprint)
      throw new ProbeError(result.ok ? "pin" : (result.code ?? "unknown"));
  },
  fetch: fetchPinned,
};
