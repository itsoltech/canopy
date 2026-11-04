import { Schema } from "effect";
import type { JsonObject, JsonValue } from "@canopy/domain";

/**
 * JSON-RPC peer for `codex app-server` (docs/agent-bus.md, docs/execution.md).
 *
 * Wire format (observed on Codex 0.164.0): one JSON object per line over stdio, no "jsonrpc" field.
 * - client -> server: requests {id, method, params} and notifications {method, params},
 * - server -> client: responses {id, result} | {id, error}, notifications {method, params},
 *   and requests {id, method, params} (approvals, dynamic tool calls) that expect a response.
 *
 * Transport-agnostic so it can be tested without a process.
 */

export interface RpcTransport {
  write(line: string): void;
  readonly lines: AsyncIterable<string>;
}

export interface RpcHandlers {
  onNotification(method: string, params: JsonValue | undefined): void;
  /** Answer a server request. Throw RpcError to answer with an error. */
  onRequest(method: string, params: JsonValue | undefined): Promise<JsonValue | undefined>;
}

export class RpcError extends Error {
  override readonly name = "RpcError";
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(`${method}: ${message} (${code})`);
  }
}

export class RpcClosedError extends Error {
  override readonly name = "RpcClosedError";
}

interface Pending {
  readonly method: string;
  resolve(result: JsonValue | undefined): void;
  reject(error: Error): void;
}

const Incoming = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Json),
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.Number,
      message: Schema.String,
      data: Schema.optionalKey(Schema.Json),
    }),
  ),
});

type Incoming = typeof Incoming.Type;

export class JsonRpcPeer {
  readonly #transport: RpcTransport;
  readonly #handlers: RpcHandlers;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed: Error | undefined;

  constructor(transport: RpcTransport, handlers: RpcHandlers) {
    this.#transport = transport;
    this.#handlers = handlers;
  }

  request(method: string, params: JsonValue): Promise<JsonValue | undefined> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#send({ id, method, params });
    });
  }

  notify(method: string, params?: JsonValue): void {
    if (this.#closed) throw this.#closed;
    this.#send(params === undefined ? { method } : { method, params });
  }

  /** Reads until the transport ends. Pending requests fail with RpcClosedError afterwards. */
  async run(): Promise<void> {
    try {
      for await (const line of this.#transport.lines) {
        if (line.trim() === "") continue;
        let message: Incoming;

        try {
          message = Schema.decodeUnknownSync(Incoming)(JSON.parse(line));
        } catch {
          continue; // not ours (e.g. a stray log line); the protocol is line-delimited JSON only
        }

        this.#dispatch(message);
      }

      this.#close(new RpcClosedError("codex app-server closed its output"));
    } catch (error) {
      this.#close(error instanceof Error ? error : new RpcClosedError(String(error)));
    }
  }

  #dispatch(message: Incoming): void {
    if (message.method === undefined) {
      if (!Schema.is(Schema.Number)(message.id)) return;
      const pending = this.#pending.get(message.id);

      if (!pending) return;
      this.#pending.delete(message.id);

      if (message.error)
        pending.reject(new RpcError(pending.method, message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);

      return;
    }

    if (message.id === undefined) {
      this.#handlers.onNotification(message.method, message.params);

      return;
    }

    const { id, method, params } = message;
    this.#handlers.onRequest(method, params).then(
      (result) => this.#safeSend({ id, ...(result !== undefined && { result }) }),
      (cause: unknown) =>
        this.#safeSend({
          id,
          error:
            cause instanceof RpcError
              ? { code: cause.code, message: cause.message }
              : { code: -32603, message: cause instanceof Error ? cause.message : String(cause) },
        }),
    );
  }

  #send(message: JsonObject): void {
    this.#transport.write(`${JSON.stringify(message)}\n`);
  }

  #safeSend(message: JsonObject): void {
    if (!this.#closed) this.#send(message);
  }

  #close(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;

    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

/** Splits a byte stream into lines (UTF-8, \n separated). */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;

    while ((index = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
    }
  }

  if (buffer.length > 0) yield buffer;
}
