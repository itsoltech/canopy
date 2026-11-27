import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError, type Client } from "@connectrpc/connect";

const RETRY_MIN_MS = 100;
const RETRY_MAX_MS = 10_000;

type Gateway = Pick<Client<typeof ui.GatewayService>, "watchThreadHeads">;

/**
 * WatchThreadHeads for the BFF's head union. A new selection reopens only this small stream; the shared
 * WatchOverview, its snapshot and every renderer stream stay open. Heads are a latest value, so a reopened or
 * retried stream loses nothing: its first message is the current set.
 */
export class BffThreadHeads {
  readonly #api: Gateway;
  readonly #receive: (heads: ui.ThreadHeads) => void;
  readonly #unsupported: () => void;
  #ids = "";
  #stream: AbortController | undefined;
  #closed = false;

  constructor(api: Gateway, receive: (heads: ui.ThreadHeads) => void, unsupported: () => void) {
    this.#api = api;
    this.#receive = receive;
    this.#unsupported = unsupported;
  }

  /** The stream follows its last selection (an empty one needs no stream). */
  get following(): boolean {
    return this.#stream !== undefined || this.#ids === "";
  }

  select(ids: readonly string[]): void {
    const key = ids.join(",");

    if (this.#closed || (key === this.#ids && this.#stream)) return;
    this.#stream?.abort();
    this.#stream = undefined;
    this.#ids = key;

    if (!ids.length) return;
    const stream = new AbortController();
    this.#stream = stream;
    void this.#follow([...ids], stream);
  }

  close(): void {
    this.#closed = true;
    this.#stream?.abort();
    this.#stream = undefined;
  }

  async #follow(ids: string[], stream: AbortController): Promise<void> {
    const signal = stream.signal;
    let retry = RETRY_MIN_MS;

    while (!signal.aborted) {
      try {
        const request = create(ui.WatchThreadHeadsRequestSchema, { threadIds: ids });

        for await (const heads of this.#api.watchThreadHeads(request, { signal, timeoutMs: 0 })) {
          if (signal.aborted) return;
          retry = RETRY_MIN_MS;
          this.#receive(heads);
        }
      } catch (cause) {
        if (signal.aborted) return;

        // An older gateway follows heads only on WatchOverview.
        if (ConnectError.from(cause).code === Code.Unimplemented) {
          if (this.#stream === stream) this.#stream = undefined;
          this.#unsupported();

          return;
        }
      }

      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };

        const timer = setTimeout(done, retry);
        signal.addEventListener("abort", done, { once: true });
      });
      retry = Math.min(RETRY_MAX_MS, retry * 2);
    }
  }
}
