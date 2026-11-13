import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  CommandSchema,
  type CommandResult,
  type CloneProgress,
  type GatewayMessage,
  type Hello,
  type WorkerMessage,
  type NetworkRouteStatus,
} from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { gatewayMessage, type GatewayPayloadInit } from "./messages.ts";
import type { RpcObservation } from "../diagnostics/collector.ts";
import { LogPullClient } from "../diagnostics/log-pull.ts";
import { TraceWorkerClient } from "../diagnostics/trace-worker.ts";

type KindInit = NonNullable<MessageInitShape<typeof CommandSchema>["kind"]>;

/** One command variant, e.g. `{ case: "unloadThread", value: { threadId } }`. */
export type CommandInit = Exclude<KindInit, { case: undefined }>;

interface PendingCommand {
  promise: Promise<CommandResult>;
  resolve(result: CommandResult): void;
  reject(cause: unknown): void;
  timer: Timer;
  progress?: (progress: CloneProgress) => void;
  observation: RpcObservation | undefined;
}

/** One live WorkerLinkService.Connect stream, seen from the gateway. */
export class WorkerConnection {
  readonly workerId: string;
  readonly hello: Hello;
  readonly threadLifecycle = new Map<string, boolean>();
  threadLifecycleRevision = 0;
  networkRouteStatus: NetworkRouteStatus | undefined;
  /** Worker messages after the handshake. CommandResults matched by sendCommand() are not repeated here. */
  readonly messages: AsyncIterable<WorkerMessage>;
  /** Resolves when the stream ends, for any reason. */
  readonly closed: Promise<void>;
  readonly logSource: LogPullClient;
  readonly tracing: TraceWorkerClient;

  readonly #outbound: AsyncChannel<GatewayMessage>;
  readonly #inbound = new AsyncChannel<WorkerMessage>();
  readonly #pending = new Map<string, PendingCommand>();
  #markClosed!: () => void;

  constructor(
    workerId: string,
    hello: Hello,
    outbound: AsyncChannel<GatewayMessage>,
    readonly observeCommand?: (kind: string) => RpcObservation | undefined,
  ) {
    this.workerId = workerId;
    this.hello = hello;
    this.networkRouteStatus = hello.networkRouteStatus;
    this.tracing = new TraceWorkerClient((command) => this.send({ case: "diagnosticsTraceCommand", value: command }));
    this.logSource = new LogPullClient(crypto.randomUUID(), (command) =>
      this.send({ case: "diagnosticsLogCommand", value: command }),
    );
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
  sendCommand(
    command: CommandInit,
    timeoutMs = 10_000,
    commandId = Bun.randomUUIDv7(),
    progress?: (progress: CloneProgress) => void,
  ): Promise<CommandResult> {
    const existing = this.#pending.get(commandId);

    if (existing) return existing.promise;
    const observation = this.observeCommand?.(command.case);
    const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();

    const timer = setTimeout(() => {
      this.#pending.delete(commandId);
      observation?.finish(Code.DeadlineExceeded);
      reject(new ConnectError(`command ${commandId} timed out`, Code.DeadlineExceeded));
    }, timeoutMs);

    this.#pending.set(commandId, { promise, resolve, reject, timer, observation, ...(progress && { progress }) });

    try {
      this.send({ case: "command", value: create(CommandSchema, { commandId, kind: command }) });
    } catch (error) {
      clearTimeout(timer);
      this.#pending.delete(commandId);
      observation?.finish(ConnectError.from(error).code);
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
    if (message.payload.case === "diagnosticsTraceReply") {
      this.tracing.receive(message.payload.value);

      return;
    }

    if (message.payload.case === "diagnosticsLogReply") {
      this.logSource.receive(message.payload.value);

      return;
    }

    if (message.payload.case === "cloneProgress") {
      this.#pending.get(message.payload.value.commandId)?.progress?.(message.payload.value);

      return;
    }

    if (message.payload.case === "commandResult") {
      const pending = this.#pending.get(message.payload.value.commandId);

      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(message.payload.value.commandId);
        pending.observation?.finish(message.payload.value.ok ? 0 : Code.Unknown);
        pending.resolve(message.payload.value);

        return;
      }
    }

    this.#inbound.push(message);
  }

  /** @internal Called by the service when the inbound side ends. */
  finish(cause: unknown): void {
    this.#outbound.close();
    this.#finish(cause);
  }

  #finish(cause: unknown): void {
    this.tracing.close();
    this.logSource.close();
    this.#inbound.close(cause);
    const reason = new ConnectError(`worker ${this.workerId} disconnected`, Code.Unavailable);

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.observation?.finish(Code.Unavailable);
      pending.reject(reason);
    }

    this.#pending.clear();
    this.#markClosed();
  }
}
