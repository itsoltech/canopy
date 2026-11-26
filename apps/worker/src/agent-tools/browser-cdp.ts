import type { JsonValue } from "@canopy/domain";
import { z } from "zod";
import { requestDeadline } from "../agent-tools-mcp/protocol.ts";

const response = z.object({
  id: z.number().optional(),
  result: z.json().optional(),
  error: z.object({}).optional(),
  method: z.string().optional(),
  params: z.json().optional(),
  sessionId: z.string().optional(),
});

const attached = z.object({ sessionId: z.string() });

/** A private connection to the active tab of an existing local Agent Browser session. */
export class BrowserCdp {
  readonly #socket: WebSocket;
  readonly #waiting = new Map<number, PromiseWithResolvers<JsonValue>>();
  #sequence = 0;
  #sessionId: string | undefined;
  #onEvent: ((method: string, params: JsonValue) => void) | undefined;
  readonly #closed = Promise.withResolvers<void>();

  private constructor(url: URL) {
    this.#socket = new WebSocket(url);
    this.#socket.addEventListener("message", (event) => this.#receive(event.data));
    this.#socket.addEventListener("close", () => this.#disconnect(), { once: true });
    this.#socket.addEventListener("error", () => this.#disconnect(), { once: true });
  }

  static async attach(rawUrl: string, targetId: string, signal: AbortSignal): Promise<BrowserCdp> {
    const url = new URL(rawUrl);

    if (
      url.protocol !== "ws:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      !/^\/devtools\/browser\/[a-f0-9-]+$/.test(url.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Browser controls require the local Chrome session.");
    const deadline = requestDeadline([signal], 3_000);
    const cdp = new BrowserCdp(url);
    const stop = () => cdp.close();
    deadline.signal.addEventListener("abort", stop, { once: true });
    const opened = Promise.withResolvers<void>();
    cdp.#socket.addEventListener("open", () => opened.resolve(), { once: true });

    try {
      deadline.signal.throwIfAborted();
      await Promise.race([opened.promise, cdp.#closed.promise]);
      const result = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      cdp.#sessionId = attached.parse(result).sessionId;

      return cdp;
    } catch (error) {
      cdp.close();
      throw error;
    } finally {
      deadline.signal.removeEventListener("abort", stop);
      deadline.dispose();
    }
  }

  onEvent(listener: (method: string, params: JsonValue) => void): void {
    this.#onEvent = listener;
  }

  send(method: string, params: Record<string, JsonValue> = {}): Promise<JsonValue> {
    if (this.#socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Browser controls disconnected."));
    const id = ++this.#sequence;
    const result = Promise.withResolvers<JsonValue>();
    this.#waiting.set(id, result);

    try {
      this.#socket.send(JSON.stringify({ id, method, params, sessionId: this.#sessionId }));
    } catch {
      this.close();
    }

    return result.promise;
  }

  #receive(data: string | ArrayBuffer | Blob): void {
    const wire = z
      .string()
      .max(64 * 1024)
      .safeParse(data);

    if (!wire.success) return;
    let parsed: ReturnType<typeof response.safeParse>;

    try {
      parsed = response.safeParse(JSON.parse(wire.data));
    } catch {
      this.close();

      return;
    }

    if (!parsed.success) return;
    const message = parsed.data;

    if (message.id !== undefined) {
      const waiting = this.#waiting.get(message.id);
      this.#waiting.delete(message.id);

      if (message.error) waiting?.reject(new Error("Chrome refused the browser control."));
      else waiting?.resolve(message.result ?? null);

      return;
    }

    if (message.method && message.sessionId === this.#sessionId)
      this.#onEvent?.(message.method, message.params ?? null);
  }

  #disconnect(): void {
    this.#closed.resolve();

    for (const result of this.#waiting.values()) result.reject(new Error("Browser controls disconnected."));
    this.#waiting.clear();
  }

  close(): void {
    this.#disconnect();
    this.#socket.close();
  }
}
