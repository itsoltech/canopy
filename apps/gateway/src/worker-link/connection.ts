import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  CommandSchema,
  type CommandResult,
  type GatewayMessage,
  type Hello,
  type WorkerMessage,
} from "@open-agents/contracts";
import { AsyncChannel } from "@open-agents/transport";
import { gatewayMessage, type GatewayPayloadInit } from "./messages.ts";

type KindInit = NonNullable<MessageInitShape<typeof CommandSchema>["kind"]>;
/** One command variant, e.g. `{ case: "unloadThread", value: { threadId } }`. */
export type CommandInit = Exclude<KindInit, { case: undefined }>;

interface PendingCommand {
  promise: Promise<CommandResult>;
  resolve(result: CommandResult): void;
  reject(error: unknown): void;
  timer: Timer;
}

/** One live WorkerLinkService.Connect stream, seen from the gateway. */
export class WorkerConnection {
  readonly workerId: string;
  readonly hello: Hello;
  /** Worker messages after the handshake. CommandResults matched by sendCommand() are not repeated here. */
  readonly messages: AsyncIterable<WorkerMessage>;
  /** Resolves when the stream ends, for any reason. */
  readonly closed: Promise<void>;

  readonly #outbound: AsyncChannel<GatewayMessage>;
  readonly #inbound = new AsyncChannel<WorkerMessage>();
  readonly #pending = new Map<string, PendingCommand>();
  #markClosed!: () => void;

  constructor(workerId: string, hello: Hello, outbound: AsyncChannel<GatewayMessage>) {
    this.workerId = workerId;
    this.hello = hello;
    this.#outbound = outbound;
    this.messages = this.#inbound;
    this.closed = new Promise((resolve) => (this.#markClosed = resolve));
  }

  get isOpen(): boolean {
    return !this.#outbound.closed;
  }

  send(payload: GatewayPayloadInit): void {
    if (!this.#outbound.push(gatewayMessage(payload))) {
      throw new ConnectError(`worker ${this.workerId} is offline`, Code.Unavailable);
    }
  }

  /** Sends a command, preserving its durable outbox id on retries. Concurrent retries share the acknowledgement. */
  sendCommand(command: CommandInit, timeoutMs = 10_000, commandId = Bun.randomUUIDv7()): Promise<CommandResult> {
    const existing = this.#pending.get(commandId);
    if (existing) return existing.promise;
    const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
    const timer = setTimeout(() => {
      this.#pending.delete(commandId);
      reject(new ConnectError(`command ${commandId} timed out`, Code.DeadlineExceeded));
    }, timeoutMs);
    this.#pending.set(commandId, { promise, resolve, reject, timer });
    try {
      this.send({ case: "command", value: create(CommandSchema, { commandId, kind: command }) });
    } catch (error) {
      clearTimeout(timer);
      this.#pending.delete(commandId);
      reject(error);
    }
    return promise;
  }

  /** Ends the stream from the gateway side (e.g. credential revoked, replaced by a newer connection). */
  close(): void {
    this.#outbound.close();
    this.#finish(undefined);
  }

  /** @internal Called by the service for every inbound message. */
  deliver(message: WorkerMessage): void {
    if (message.payload.case === "commandResult") {
      const pending = this.#pending.get(message.payload.value.commandId);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(message.payload.value.commandId);
        pending.resolve(message.payload.value);
        return;
      }
    }
    this.#inbound.push(message);
  }

  /** @internal Called by the service when the inbound side ends. */
  finish(error: unknown): void {
    this.#outbound.close();
    this.#finish(error);
  }

  #finish(error: unknown): void {
    this.#inbound.close(error);
    const reason = new ConnectError(`worker ${this.workerId} disconnected`, Code.Unavailable);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
    this.#markClosed();
  }
}
