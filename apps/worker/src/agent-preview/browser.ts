import type { AgentPreviewInput } from "@canopy/contracts";
import { z } from "zod";
import { Match } from "effect";
import { jpegFrame } from "./frames.ts";
import type { PreviewBackend, PreviewContext, PreviewUpdate } from "./types.ts";
import type { JsonValue } from "./runtime.ts";
import {
  acquireBrowserStream,
  releaseBrowserStream,
  type BrowserLease,
  BrowserViewport,
  errorMessage,
  frameMessage,
  buttonHeldElsewhere,
  keyHeldElsewhere,
  heldInput,
  keyboardMessage,
  MAX_STREAM_MESSAGE,
  messageType,
  mouseButton,
  previewText,
  statusMessage,
  sendBrowserText,
  tabsMessage,
  urlMessage,
} from "./browser-support.ts";

class BrowserPreview implements PreviewBackend {
  readonly #context: PreviewContext;
  readonly #owners = new Set<string>();
  readonly #viewport = new BrowserViewport();
  #socket: WebSocket | undefined;
  #lease: BrowserLease | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #processing = false;
  #ack: number | undefined;
  #timer: Timer | undefined;
  #width = 0;
  #height = 0;
  #metadata: PreviewUpdate = { mode: "stream" };
  readonly #abort = () => void this.close().catch(() => undefined);

  constructor(context: PreviewContext) {
    this.#context = context;
  }

  async start(): Promise<void> {
    const context = this.#context;

    if (context.runtime.scope.target) throw new Error("Browser previews use the session tabs");
    context.signal.throwIfAborted();
    context.emit({ state: "connecting", mode: "stream" });
    this.#lease = await acquireBrowserStream(context.runtime);

    if (this.#closed || context.signal.aborted) {
      await releaseBrowserStream(context.runtime, this.#lease);
      this.#lease = undefined;
      context.signal.throwIfAborted();

      return;
    }

    context.signal.addEventListener("abort", this.#abort, { once: true });
    const socket = new WebSocket(`ws://127.0.0.1:${this.#lease.port}/?pacing=ack&maxFps=12`);
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event: MessageEvent<string | ArrayBuffer | Blob>) => {
      void this.#message(event).catch((error) => this.#fail(error));
    });
    socket.addEventListener("close", () => {
      if (!this.#closed) this.#fail(new Error("Browser stream disconnected; reopen the preview"));
    });

    try {
      await this.#connect(socket);
    } catch (error) {
      await this.close();
      throw error;
    }

    this.#timer = setInterval(() => {
      if (this.#ack !== undefined && context.active()) {
        try {
          this.#send({ type: "ack", seq: this.#ack });
          this.#ack = undefined;
        } catch (error) {
          this.#fail(error instanceof Error ? error : new Error("Browser stream acknowledgement failed"));
        }
      }
    }, 25);
  }

  #connect(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
        this.#context.signal.removeEventListener("abort", aborted);

        if (error) reject(error);
        else resolve();
      };

      const opened = () => finish();
      const failed = () => finish(new Error("Could not connect to the browser stream"));
      const aborted = () => finish(new Error("Browser preview stopped"));
      const timeout = setTimeout(() => finish(new Error("Browser stream connection timed out")), 8_000);
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
      this.#context.signal.addEventListener("abort", aborted, { once: true });
    });
  }

  async #message(event: MessageEvent<string | ArrayBuffer | Blob>): Promise<void> {
    if (this.#closed) return;
    // Check the transport value before JSON parsing or allocating the decoded image.
    const text = z.string().max(MAX_STREAM_MESSAGE).parse(event.data);

    if (Buffer.byteLength(text) > MAX_STREAM_MESSAGE) throw new Error("Browser stream message exceeds its limit");
    const parsed = JSON.parse(text);
    const header = messageType.parse(parsed);

    switch (header.type) {
      case "frame":
        await this.#frame(frameMessage.parse(parsed));
        break;
      case "status": {
        const status = statusMessage.parse(parsed);
        this.#viewport.invalidate();

        if (status.connected && status.engine && status.engine !== "chrome")
          throw new Error("Live browser preview requires a Chrome session");
        this.#context.emit({
          ...this.#metadata,
          state: "ready",
          viewportWidth: this.#width,
          viewportHeight: this.#height,
          detail: status.connected ? "" : "Waiting for a page…",
        });
        break;
      }

      case "tabs":
        this.#tabs(tabsMessage.parse(parsed));
        break;
      case "url":
        this.#viewport.invalidate();
        this.#metadata.url = previewText(urlMessage.parse(parsed).url, 8192);
        this.#context.emit({ ...this.#metadata, state: "ready" });
        break;
      case "error":
        throw new Error(previewText(errorMessage.parse(parsed).message, 4096));
    }
  }

  async #frame(frame: z.infer<typeof frameMessage>): Promise<void> {
    if (this.#processing || this.#ack !== undefined) throw new Error("Browser stream ignored frame pacing");
    this.#processing = true;

    try {
      if (frame.data.length % 4) throw new Error("Browser stream returned invalid image encoding");
      const image = await jpegFrame(Buffer.from(frame.data, "base64"));
      const viewport = await this.#viewport.measure(this.#context.runtime, frame, image);

      if (this.#closed) return;
      this.#width = viewport.width;
      this.#height = viewport.height;
      this.#metadata.viewportWidth = this.#width;
      this.#metadata.viewportHeight = this.#height;
      this.#ack = frame.seq;
      this.#context.emit({ ...this.#metadata, ...image, state: "frame" });
    } finally {
      this.#processing = false;
    }
  }

  #tabs(message: z.infer<typeof tabsMessage>): void {
    const active = message.tabs.find((tab) => tab.active);

    if (active?.tabId !== this.#metadata.targetId || active?.url !== this.#metadata.url) this.#viewport.invalidate();
    this.#metadata = {
      ...this.#metadata,
      targetId: active?.tabId ?? "",
      url: previewText(active?.url ?? "", 8192),
      title: previewText(active?.title ?? "", 4096),
      targets: message.tabs.map((tab) => ({
        id: tab.tabId,
        label: previewText(tab.title || tab.url || tab.tabId, 160),
        active: tab.active,
      })),
    };
    this.#context.emit({ ...this.#metadata, state: "ready" });
  }

  #send(message: JsonValue): void {
    const socket = this.#socket;

    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Browser stream is unavailable");

    if (socket.bufferedAmount > 256 * 1024) throw new Error("Browser input is arriving too quickly");
    socket.send(JSON.stringify(message));
  }

  async input(inputs: readonly AgentPreviewInput[], owner: string): Promise<void> {
    if (this.#closed || !this.#lease) throw new Error("Browser preview is closed");

    for (const input of inputs) {
      this.#context.signal.throwIfAborted();

      if (input.kind !== "release") this.#owners.add(owner);

      switch (input.kind) {
        case "pointer-move":
        case "pointer-down":
        case "pointer-up":
        case "wheel":
          this.#pointer(input, owner, this.#lease);
          break;
        case "key-down":
        case "key-up":
          this.#key(input, owner, this.#lease);
          break;
        case "text":
          if (!this.#socket) throw new Error("Browser stream is unavailable");
          await sendBrowserText(this.#socket, input.text, this.#context.signal, (message) => this.#send(message));
          break;
        case "release":
          await this.release(owner);
          break;
        case "navigate":
        case "home":
        case "back":
        case "forward":
        case "reload":
        case "resize":
        case "tab":
          await this.#command(input);
          break;
        default:
          throw new Error("Unsupported browser preview input");
      }
    }
  }

  #pointer(input: AgentPreviewInput, owner: string, lease: BrowserLease): void {
    if (!this.#width || !this.#height) throw new Error("Wait for a browser frame before using the pointer");
    const held = heldInput(lease, owner);
    held.x = Math.max(0, Math.min(this.#width - 1, input.x * this.#width));
    held.y = Math.max(0, Math.min(this.#height - 1, input.y * this.#height));

    let button =
      input.kind === "pointer-move" ? mouseButton(held.buttons.values().next().value ?? -1) : mouseButton(input.button);

    if (input.kind === "pointer-down") {
      held.buttons.add(input.button);
      const previous = held.click;
      const at = Date.now();

      const consecutive =
        previous &&
        previous.button === input.button &&
        at - previous.at <= 400 &&
        Math.hypot(held.x - previous.x, held.y - previous.y) <= 5;

      held.click = {
        button: input.button,
        x: held.x,
        y: held.y,
        at,
        count: consecutive ? (previous.count % 3) + 1 : 1,
      };
    }

    if (input.kind === "pointer-up") {
      if (!held.buttons.delete(input.button) || buttonHeldElsewhere(lease, owner, input.button)) return;
    }

    if (input.kind === "wheel") button = "none";
    this.#send({
      type: "input_mouse",
      eventType: Match.value(input.kind).pipe(
        Match.when("pointer-down", () => "mousePressed"),
        Match.when("pointer-up", () => "mouseReleased"),
        Match.when("wheel", () => "mouseWheel"),
        Match.orElse(() => "mouseMoved"),
      ),
      x: held.x,
      y: held.y,
      button,
      modifiers: input.modifiers,
      clickCount: input.kind === "pointer-down" || input.kind === "pointer-up" ? (held.click?.count ?? 1) : 0,
      deltaX: input.deltaX,
      deltaY: input.deltaY,
    });
  }

  #key(input: AgentPreviewInput, owner: string, lease: BrowserLease): void {
    const held = heldInput(lease, owner);
    const key = input.code || input.key;

    if (input.kind === "key-down") held.keys.set(key, input);
    else if (!held.keys.delete(key) || keyHeldElsewhere(lease, owner, key)) return;
    this.#send(keyboardMessage(input, input.kind === "key-down" ? "keyDown" : "keyUp"));
  }

  async #command(input: AgentPreviewInput): Promise<void> {
    const runtime = this.#context.runtime;
    this.#viewport.invalidate();

    if (input.kind === "resize") {
      const dimensions = z
        .object({ width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192) })
        .parse(input);

      await runtime.command(["set", "viewport", String(dimensions.width), String(dimensions.height)]);
    } else if (input.kind === "navigate" || input.kind === "home") {
      const url = input.kind === "home" ? "about:blank" : input.text;

      if (url !== "about:blank" && !["http:", "https:"].includes(new URL(url).protocol))
        throw new Error("Choose an HTTP or HTTPS preview URL");
      await runtime.command(["open", url, "--headed", "false"]);
    } else if (input.kind === "tab") {
      const tabId = z.string().min(1).max(128).parse(input.text);
      const target = this.#metadata.targets?.find((entry) => entry.id === tabId);

      if (!target) throw new Error("Choose an open browser tab");

      if (target.id === this.#metadata.targetId) return;
      await runtime.command(["tab", tabId]);
    } else await runtime.command([input.kind]);
  }

  async release(owner: string): Promise<void> {
    const lease = this.#lease;
    const held = lease?.held.get(owner);
    this.#owners.delete(owner);

    if (!lease || !held) return;
    lease.held.delete(owner);

    if (this.#socket?.readyState !== WebSocket.OPEN) return;

    for (const button of held.buttons) {
      if (!buttonHeldElsewhere(lease, owner, button))
        this.#send({
          type: "input_mouse",
          eventType: "mouseReleased",
          x: held.x,
          y: held.y,
          button: mouseButton(button),
          clickCount: 1,
        });
    }

    for (const [key, input] of held.keys) {
      if (!keyHeldElsewhere(lease, owner, key)) this.#send(keyboardMessage({ ...input, modifiers: 0 }, "keyUp"));
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#context.emit({
      state: "error",
      mode: "stream",
      detail: previewText(this.#context.runtime.redact(error.message), 4096),
    });
    void this.close().catch(() => undefined);
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();

    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#context.signal.removeEventListener("abort", this.#abort);

    try {
      for (const owner of this.#owners) await this.release(owner).catch(() => undefined);
    } finally {
      this.#socket?.close();
      const lease = this.#lease;
      this.#lease = undefined;

      if (lease) await releaseBrowserStream(this.#context.runtime, lease);
    }
  }
}

export const browserPreview = (context: PreviewContext): PreviewBackend => new BrowserPreview(context);
