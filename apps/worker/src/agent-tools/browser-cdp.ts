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
  #targetId: string | undefined;
  #onEvent: ((method: string, params: JsonValue) => void) | undefined;
  readonly #closed = Promise.withResolvers<void>();
  #onSessionEvent: ((method: string, params: JsonValue, sessionId: string | undefined) => void) | undefined;

  private constructor(
    url: URL,
    private readonly maxMessageBytes: number,
  ) {
    this.#socket = new WebSocket(url);
    this.#socket.addEventListener("message", (event) => this.#receive(event.data));
    this.#socket.addEventListener("close", () => this.#disconnect(), { once: true });
    this.#socket.addEventListener("error", () => this.#disconnect(), { once: true });
  }

  static async attach(
    rawUrl: string,
    targetId: string,
    signal: AbortSignal,
    maxMessageBytes?: number,
  ): Promise<BrowserCdp> {
    const deadline = requestDeadline([signal], 3_000);

    try {
      const cdp = await BrowserCdp.connect(rawUrl, deadline.signal, maxMessageBytes);
      const stop = () => cdp.close();
      deadline.signal.addEventListener("abort", stop, { once: true });

      try {
        const result = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        cdp.#sessionId = attached.parse(result).sessionId;
        cdp.#targetId = targetId;

        return cdp;
      } catch (error) {
        cdp.close();
        throw error;
      } finally {
        deadline.signal.removeEventListener("abort", stop);
      }
    } finally {
      deadline.dispose();
    }
  }

  /** A browser-level connection; `maxMessageBytes` bounds one message from Chrome. */
  static async connect(rawUrl: string, signal: AbortSignal, maxMessageBytes = 64 * 1024): Promise<BrowserCdp> {
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
    const cdp = new BrowserCdp(url, maxMessageBytes);
    const stop = () => cdp.close();
    deadline.signal.addEventListener("abort", stop, { once: true });
    const opened = Promise.withResolvers<void>();
    cdp.#socket.addEventListener("open", () => opened.resolve(), { once: true });

    try {
      deadline.signal.throwIfAborted();
      await Promise.race([opened.promise, cdp.#closed.promise]);
      deadline.signal.throwIfAborted();

      if (cdp.#socket.readyState !== WebSocket.OPEN) throw new Error("Browser controls disconnected.");

      return cdp;
    } catch (error) {
      cdp.close();
      throw error;
    } finally {
      deadline.signal.removeEventListener("abort", stop);
      deadline.dispose();
    }
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** The tab this connection attached to. */
  get targetId(): string | undefined {
    return this.#targetId;
  }

  get closed(): Promise<void> {
    return this.#closed.promise;
  }

  /** Events of every attached session; `sessionId` is undefined for the browser itself. */
  onSessionEvent(listener: (method: string, params: JsonValue, sessionId: string | undefined) => void): void {
    this.#onSessionEvent = listener;
  }

  onEvent(listener: (method: string, params: JsonValue) => void): void {
    this.#onEvent = listener;
  }

  send(method: string, params: Record<string, JsonValue> = {}): Promise<JsonValue> {
    return this.sendTo(this.#sessionId, method, params);
  }

  /** Send to another flattened session, or to the browser when `sessionId` is undefined. */
  sendTo(sessionId: string | undefined, method: string, params: Record<string, JsonValue> = {}): Promise<JsonValue> {
    if (this.#socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Browser controls disconnected."));
    const id = ++this.#sequence;
    const result = Promise.withResolvers<JsonValue>();
    this.#waiting.set(id, result);

    try {
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    } catch {
      this.close();
    }

    return result.promise;
  }

  #receive(data: string | ArrayBuffer | Blob): void {
    const wire = z.string().max(this.maxMessageBytes).safeParse(data);

    // A dropped message could leave a request paused; closing releases this client's interception.
    if (!wire.success) {
      const raw = z.string().safeParse(data);
      const reply = raw.success ? /^\{"id":(\d+)[,}]/.exec(raw.data) : null;

      if (this.#onSessionEvent) this.close();
      // A reply too large to read fails its command instead of leaving it waiting.
      else if (reply) this.#reject(Number(reply[1]));

      return;
    }

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

    if (message.method) this.#onSessionEvent?.(message.method, message.params ?? null, message.sessionId);

    if (message.method && message.sessionId === this.#sessionId)
      this.#onEvent?.(message.method, message.params ?? null);
  }

  #reject(id: number): void {
    this.#waiting.get(id)?.reject(new Error("Chrome's reply exceeded the browser control limit."));
    this.#waiting.delete(id);
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
