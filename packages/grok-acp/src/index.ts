import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ClientCallbacks,
  Content,
  InitializeResult,
  McpServer,
  PermissionRequest,
  PermissionResult,
  PromptEvent,
  SessionResult,
  SessionUpdate,
  WireObject,
  WireValue,
} from "./types.ts";

export * from "./types.ts";

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

interface Pending {
  resolve(value: WireValue | undefined): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GrokOptions {
  executable?: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  callbacks?: ClientCallbacks;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  cancelTimeoutMs?: number;
  /** Additional values to redact in stderr and remote errors (endpoint and credentials). */
  secrets?: readonly string[];
  maxFrameBytes?: number;
  maxQueuedEvents?: number;
}

/** One owned CLI process. NDJSON duplex requests stay independent of slow client callbacks. */
export class GrokClient {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #options: GrokOptions;
  readonly #pending = new Map<number, Pending>();
  readonly #callbacks = new AbortController();
  readonly #streams = new Map<string, EventStream>();
  readonly #permissions = new Map<string, Set<AbortController>>();
  readonly #cancellations = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #exited: Promise<void>;
  #closed: Error | undefined;
  #nextId = 1;
  #writes = Promise.resolve();
  #stderr = "";
  #initialized: InitializeResult | undefined;
  #killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: GrokOptions = {}) {
    this.#options = options;
    this.#process = spawn(options.executable ?? "grok", [...(options.args ?? ["agent", "--no-leader", "stdio"])], {
      ...(options.cwd && { cwd: options.cwd }),
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.#exited = new Promise((resolve) => {
      this.#process.once("close", (code, signal) => {
        this.#fail(new AcpError(`Grok exited (${signal ?? code})`));
        clearTimeout(this.#killTimer);
        resolve();
      });
    });
    this.#process.on("error", () => this.#fail(new AcpError("Cannot start Grok CLI")));
    this.#process.stdin.on("error", () => this.#fail(new AcpError("Grok stdin closed")));
    this.#process.stderr.setEncoding("utf8");
    // Keep a bounded raw tail, redact only when read: a secret can span data chunks.
    this.#process.stderr.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-16_384);
    });
    void this.#read();
  }

  get stderr(): string {
    return this.#redact(this.#stderr);
  }
  get pid(): number | undefined {
    return this.#process.pid;
  }
  get capabilities(): InitializeResult | undefined {
    return this.#initialized;
  }
  get closed(): boolean {
    return !!this.#closed;
  }

  async initialize(): Promise<InitializeResult> {
    const cb = this.#options.callbacks;
    this.#initialized = await this.request<InitializeResult>("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "canopy", version: "1" },
      clientCapabilities: {
        fs: { readTextFile: !!cb?.readTextFile, writeTextFile: !!cb?.writeTextFile },
        terminal: !!cb?.terminal,
      },
    });

    if (this.#initialized.protocolVersion !== 1) throw new AcpError("Unsupported ACP version");

    return this.#initialized;
  }

  authenticate(methodId: string): Promise<WireValue | undefined> {
    return this.request("authenticate", { methodId, _meta: { headless: true } });
  }
  newSession(cwd: string, mcpServers: McpServer[] = [], meta?: WireObject): Promise<SessionResult> {
    return this.request("session/new", { cwd, mcpServers, ...(meta && { _meta: meta }) });
  }
  loadSession(sessionId: string, cwd: string, mcpServers: McpServer[] = []): Promise<SessionResult> {
    if (!this.#initialized?.agentCapabilities?.loadSession)
      return Promise.reject(new AcpError("Grok does not support session/load"));

    return this.request<Omit<SessionResult, "sessionId">>("session/load", { sessionId, cwd, mcpServers }).then(
      (result) => ({ ...result, sessionId }),
    );
  }
  setMode(sessionId: string, modeId: string): Promise<WireValue | undefined> {
    return this.request("session/set_mode", { sessionId, modeId });
  }
  setModel(sessionId: string, modelId: string): Promise<WireValue | undefined> {
    return this.request("session/set_model", { sessionId, modelId });
  }
  cancel(sessionId: string): Promise<void> {
    for (const controller of this.#permissions.get(sessionId) ?? []) controller.abort();

    if (this.#streams.has(sessionId) && !this.#cancellations.has(sessionId))
      this.#cancellations.set(
        sessionId,
        setTimeout(
          () => this.#fail(new AcpError("Grok did not acknowledge cancellation")),
          this.#options.cancelTimeoutMs ?? 5000,
        ),
      );

    return this.#send({ method: "session/cancel", params: { sessionId } });
  }

  async *prompt(sessionId: string, prompt: Content[], signal?: AbortSignal): AsyncGenerator<PromptEvent> {
    if (this.#streams.has(sessionId)) throw new AcpError("A prompt is already running in this session");

    if (signal?.aborted) throw new AcpError("Prompt cancelled");
    const stream = new EventStream(this.#options.maxQueuedEvents ?? 4096, (error) => this.#fail(error));
    this.#streams.set(sessionId, stream);

    const abort = () => {
      void this.cancel(sessionId).catch(() => {});
    };

    signal?.addEventListener("abort", abort, { once: true });

    const result = this.request<{ stopReason: string; usage?: WireValue }>(
      "session/prompt",
      { sessionId, prompt },
      this.#options.promptTimeoutMs ?? 30 * 60_000,
    );

    void result.then(
      (value) => {
        stream.push({ type: "complete", ...value });
        stream.end();
      },
      (error: Error) => stream.end(error),
    );
    let completed = false;

    try {
      for await (const event of stream) {
        if (event.type === "complete") completed = true;
        yield event;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      this.#streams.delete(sessionId);
      clearTimeout(this.#cancellations.get(sessionId));
      this.#cancellations.delete(sessionId);

      if (!completed && !this.#closed) await this.dispose(); // abandoned consumer cannot leave a running turn
    }
  }

  request<T = WireValue | undefined>(
    method: string,
    params: WireObject,
    timeoutMs = this.#options.requestTimeoutMs ?? 30_000,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new AcpError(`ACP ${method} timed out`)), timeoutMs);
      // SAFETY: T is the ACP result type of `method`; the agent is our own child process speaking ACP v1, and callers
      // read optional fields defensively.
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      void this.#send({ id, method, params }).catch((error: Error) => this.#fail(error));
    });
  }

  async dispose(): Promise<void> {
    this.#fail(new AcpError("Grok client disposed"));
    const timer = setTimeout(() => this.#kill("SIGKILL"), 1500);

    try {
      await this.#exited;
    } finally {
      clearTimeout(timer);
      this.#kill("SIGKILL");
    }
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  #kill(signal: NodeJS.Signals): void {
    const pid = this.#process.pid;

    if (!pid) return;

    try {
      if (process.platform !== "win32") process.kill(-pid, signal);
      else this.#process.kill(signal);
    } catch {
      /* already reaped */
    }
  }
  #redact(value: string): string {
    let result = value;

    for (const secret of this.#options.secrets ?? []) if (secret) result = result.split(secret).join("[redacted]");

    return result
      .replace(
        /(Bearer\s+|(?:api[_-]?key|access_token|refresh_token|authorization)["\s:=]+)[^\s,}"']+/gi,
        "$1[redacted]",
      )
      .replace(/\b(?:xai-|sk-)[\w-]+/g, "[redacted]");
  }
  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    this.#killTimer = setTimeout(() => this.#kill("SIGKILL"), 1500);
    this.#killTimer.unref();
    this.#callbacks.abort();

    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }

    this.#pending.clear();

    for (const stream of this.#streams.values()) stream.end(error);

    for (const timer of this.#cancellations.values()) clearTimeout(timer);
    this.#cancellations.clear();
    this.#kill("SIGTERM");
  }
  #send(message: OutgoingMessage): Promise<void> {
    const write = this.#writes.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.#closed) {
            reject(this.#closed);

            return;
          }

          // The write callback waits for flushing; serializing keeps stdin buffering bounded.
          this.#process.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n", (error) =>
            error ? reject(new AcpError("Grok write failed")) : resolve(),
          );
        }),
    );

    this.#writes = write.catch(() => {});

    return write;
  }
  async #read(): Promise<void> {
    let buffer = "";
    this.#process.stdout.setEncoding("utf8");

    try {
      for await (const chunk of this.#process.stdout) {
        buffer += chunk;
        let newline: number;

        while ((newline = buffer.indexOf("\n")) >= 0) {
          if (Buffer.byteLength(buffer.slice(0, newline)) > (this.#options.maxFrameBytes ?? 16 * 1024 * 1024))
            throw new AcpError("ACP frame limit exceeded");
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);

          if (line.trim()) this.#dispatch(JSON.parse(line));
        }

        if (Buffer.byteLength(buffer) > (this.#options.maxFrameBytes ?? 16 * 1024 * 1024))
          throw new AcpError("ACP frame limit exceeded");
      }

      this.#fail(new AcpError(buffer.trim() ? "Truncated ACP frame" : "Grok stdout closed"));
    } catch {
      this.#fail(new AcpError("Invalid or closed ACP transport"));
    }
  }
  #dispatch(message: WireValue): void {
    if (!isWireObject(message) || message["jsonrpc"] !== "2.0") throw new AcpError("Invalid JSON-RPC envelope");
    const method = message["method"];
    const id = message["id"];

    if (isText(method)) {
      if (id !== undefined) {
        void this.#callback(method, message["params"])
          .then(
            (result) => this.#send({ id, result }),
            () => this.#send({ id, error: { code: -32601, message: "Unsupported or failed client callback" } }),
          )
          .catch(() => {});
      } else if (method === "session/update") {
        const params = message["params"];
        const sessionId = isWireObject(params) ? params["sessionId"] : undefined;

        if (!isWireObject(params) || !isText(sessionId)) throw new AcpError("Invalid session/update");
        // SAFETY: ACP v1 session/update params carry a SessionUpdate; consumers switch on `sessionUpdate` and skip
        // kinds they do not know.
        const update = params["update"] as SessionUpdate;
        this.#streams.get(sessionId)?.push({ type: "update", update });
      }

      return;
    }

    if (!isCount(id)) return;
    const pending = this.#pending.get(id);

    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const error = message["error"];

    if (error) pending.reject(this.#remoteError(error));
    else pending.resolve(message["result"]);
  }
  #remoteError(error: WireValue): AcpError {
    const text = isWireObject(error) ? error["message"] : undefined;

    if (!isWireObject(error) || !isText(text)) throw new AcpError("Invalid JSON-RPC error");
    const code = error["code"];

    return new AcpError(this.#redact(text), isCount(code) ? code : undefined);
  }
  async #callback(method: string, params: WireValue | undefined): Promise<WireValue | undefined> {
    const cb = this.#options.callbacks;
    const signal = this.#callbacks.signal;

    if (method === "session/request_permission") {
      // SAFETY: ACP v1 names session/request_permission params a PermissionRequest; the callback reads them as such.
      const request = params as PermissionRequest;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const pending = this.#permissions.get(request.sessionId) ?? new Set<AbortController>();
      pending.add(controller);
      this.#permissions.set(request.sessionId, pending);

      try {
        if (!cb?.requestPermission || signal.aborted) return { outcome: { outcome: "cancelled" } };

        return await Promise.race([
          cb.requestPermission(request, controller.signal),
          new Promise<PermissionResult>((resolve) =>
            controller.signal.addEventListener("abort", () => resolve({ outcome: { outcome: "cancelled" } }), {
              once: true,
            }),
          ),
        ]);
      } finally {
        pending.delete(controller);

        if (!pending.size) this.#permissions.delete(request.sessionId);
        signal.removeEventListener("abort", abort);
      }
    }

    if (method === "fs/read_text_file" && cb?.readTextFile) {
      // SAFETY: ACP v1 defines these params for fs/read_text_file.
      return cb.readTextFile(params as ReadTextFileParams);
    }

    if (method === "fs/write_text_file" && cb?.writeTextFile) {
      // SAFETY: ACP v1 defines these params for fs/write_text_file.
      return cb.writeTextFile(params as WriteTextFileParams);
    }

    if (method.startsWith("terminal/") && cb?.terminal) return cb.terminal(method, params, signal);
    throw new AcpError("Unsupported client method", -32601);
  }
}

type ReadTextFileParams = Parameters<NonNullable<ClientCallbacks["readTextFile"]>>[0];

type WriteTextFileParams = Parameters<NonNullable<ClientCallbacks["writeTextFile"]>>[0];

type OutgoingMessage =
  | { readonly id?: number; readonly method: string; readonly params: WireObject }
  | { readonly id: WireValue; readonly result: WireValue | undefined }
  | { readonly id: WireValue; readonly error: { readonly code: number; readonly message: string } };

function isWireObject(value: WireValue | undefined): value is WireObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: WireValue | undefined): value is string {
  return typeof value === "string";
}

function isCount(value: WireValue | undefined): value is number {
  return typeof value === "number";
}

class EventStream implements AsyncIterable<PromptEvent> {
  readonly #queue: PromptEvent[] = [];
  #wake: (() => void) | undefined;
  #done = false;
  #error: Error | undefined;
  constructor(
    readonly limit: number,
    readonly overflow: (error: Error) => void,
  ) {}
  push(event: PromptEvent): void {
    if (this.#done) return;

    if (this.#queue.length >= this.limit) {
      const error = new AcpError("ACP event consumer fell behind");
      this.end(error);
      this.overflow(error);

      return;
    }

    this.#queue.push(event);
    this.#wake?.();
  }
  end(error?: Error): void {
    this.#done = true;
    this.#error = error;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<PromptEvent> {
    for (;;) {
      const next = this.#queue.shift();

      if (next) {
        yield next;
        continue;
      }

      if (this.#error) throw this.#error;

      if (this.#done) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}
