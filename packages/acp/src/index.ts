import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { killProcessTree } from "@canopy/process-governor";
import { EventStream, AcpError } from "./event-stream.ts";
import { spawnAgent } from "./process.ts";
import type {
  ClientCallbacks,
  Content,
  InitializeResult,
  McpServer,
  PermissionRequest,
  PermissionResult,
  PromptEvent,
  ConfigOption,
  SessionResult,
  SessionUpdate,
  ToolCall,
  WireObject,
  WireValue,
} from "./types.ts";

export * from "./types.ts";

export { sessionSelect } from "./session-config.ts";

export { AcpError } from "./event-stream.ts";

interface Pending {
  resolve(value: WireValue | undefined): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AcpOptions {
  executable: string;
  args: readonly string[];
  /** Provider display name for errors from the CLI process. */
  agentName?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  callbacks?: ClientCallbacks;
  /** Observe a live tool call in wire order, before an independent MCP request can reach the client. */
  onToolCall?(sessionId: string, call: ToolCall): void;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  cancelTimeoutMs?: number;
  /** Additional values to redact in stderr and remote errors (endpoint and credentials). */
  secrets?: readonly string[];
  maxFrameBytes?: number;
  maxQueuedEvents?: number;
}

/** One owned CLI process. NDJSON duplex requests stay independent of slow client callbacks. */
export class AcpClient {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #options: AcpOptions;
  readonly #agentName: string;
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
  #reaped = false;
  #windowsKill: Promise<void> | undefined;

  constructor(options: AcpOptions) {
    this.#options = options;
    this.#agentName = options.agentName ?? "ACP agent";
    this.#process = spawnAgent(options);
    this.#exited = new Promise((resolve) => {
      this.#process.once("close", (code, signal) => {
        this.#fail(new AcpError(`${this.#agentName} exited (${signal ?? code})`));
        this.#kill("SIGKILL");
        this.#reaped = true;
        clearTimeout(this.#killTimer);
        resolve();
      });
    });
    this.#process.on("error", () => this.#fail(new AcpError(`Cannot start ${this.#agentName} CLI`)));
    this.#process.stdin.on("error", () => this.#fail(new AcpError(`${this.#agentName} stdin closed`)));
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
  get canRestore(): boolean {
    const capabilities = this.#initialized?.agentCapabilities;

    return capabilities?.loadSession === true || isWireObject(capabilities?.sessionCapabilities?.resume);
  }
  get closed(): boolean {
    return !!this.#closed;
  }
  get exited(): Promise<void> {
    return this.#exited;
  }

  async initialize(): Promise<InitializeResult> {
    const cb = this.#options.callbacks;

    const initialized = await this.request<InitializeResult>("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "canopy", version: "1" },
      clientCapabilities: {
        fs: { readTextFile: !!cb?.readTextFile, writeTextFile: !!cb?.writeTextFile },
        terminal: !!cb?.terminal,
      },
    });

    if (initialized?.protocolVersion !== 1) throw new AcpError("Unsupported ACP version");
    this.#initialized = initialized;

    return this.#initialized;
  }

  authenticate(methodId: string, meta?: WireObject): Promise<WireValue | undefined> {
    return this.request("authenticate", { methodId, ...(meta && { _meta: meta }) });
  }
  async newSession(cwd: string, mcpServers: McpServer[] = [], meta?: WireObject): Promise<SessionResult> {
    const result = await this.request<SessionResult>("session/new", { cwd, mcpServers, ...(meta && { _meta: meta }) });

    if (!result?.sessionId || !isText(result.sessionId)) throw new AcpError("ACP agent returned no session ID");

    return result;
  }
  loadSession(sessionId: string, cwd: string, mcpServers: McpServer[] = []): Promise<SessionResult> {
    if (this.#initialized?.agentCapabilities?.loadSession !== true)
      return Promise.reject(new AcpError("The ACP agent does not support session/load"));

    return this.#restore("session/load", sessionId, cwd, mcpServers);
  }
  /** Resume without replay is optional. An existing thread must never fall back to session/new. */
  restoreSession(sessionId: string, cwd: string, mcpServers: McpServer[] = []): Promise<SessionResult> {
    if (this.#initialized?.agentCapabilities?.loadSession === true) return this.loadSession(sessionId, cwd, mcpServers);

    if (this.canRestore) return this.#restore("session/resume", sessionId, cwd, mcpServers);

    return Promise.reject(new AcpError("The installed ACP agent cannot reopen an existing session"));
  }
  async #restore(method: string, sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<SessionResult> {
    const result = await this.request<Partial<SessionResult>>(method, { sessionId, cwd, mcpServers });

    if (!result) throw new AcpError("ACP agent returned no session details");

    if (result.sessionId !== undefined && result.sessionId !== sessionId)
      throw new AcpError("ACP agent returned a different session ID");

    return { ...result, sessionId };
  }
  setMode(sessionId: string, modeId: string): Promise<WireValue | undefined> {
    return this.request("session/set_mode", { sessionId, modeId });
  }
  setModel(sessionId: string, modelId: string): Promise<WireValue | undefined> {
    return this.request("session/set_model", { sessionId, modelId });
  }
  setConfigOption(sessionId: string, configId: string, value: string): Promise<{ configOptions: ConfigOption[] }> {
    return this.request("session/set_config_option", { sessionId, configId, value });
  }
  cancel(sessionId: string): Promise<void> {
    for (const controller of this.#permissions.get(sessionId) ?? []) controller.abort();

    if (this.#streams.has(sessionId) && !this.#cancellations.has(sessionId))
      this.#cancellations.set(
        sessionId,
        setTimeout(
          () => this.#fail(new AcpError("The ACP agent did not acknowledge cancellation")),
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

      for (const controller of this.#permissions.get(sessionId) ?? []) controller.abort();
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
    this.#fail(new AcpError("ACP client disposed"));
    await this.#exited;
    await this.#windowsKill;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  #kill(signal: NodeJS.Signals): void {
    const pid = this.#process.pid;

    if (!pid || this.#reaped) return;

    try {
      if (process.platform !== "win32") process.kill(-pid, signal);
      else this.#windowsKill ??= killProcessTree(pid);
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
            error ? reject(new AcpError(`${this.#agentName} write failed`)) : resolve(),
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

      this.#fail(new AcpError(buffer.trim() ? "Truncated ACP frame" : `${this.#agentName} stdout closed`));
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
        const stream = this.#streams.get(sessionId);

        if (stream) {
          if (update.sessionUpdate === "tool_call") this.#options.onToolCall?.(sessionId, update);
          stream.push({ type: "update", update });
        }
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

      if (!this.#streams.has(request.sessionId) || this.#cancellations.has(request.sessionId))
        return { outcome: { outcome: "cancelled" } };
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
