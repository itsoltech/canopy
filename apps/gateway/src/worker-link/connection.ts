import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  CommandSchema,
  ItemDeltaField,
  type ThreadEvent,
  WorkerConfigSchema,
  type CommandResult,
  type ConfigApplied,
  type CloneProgress,
  type QueryProgress,
  type GatewayMessage,
  type Hello,
  type WorkerMessage,
  type NetworkRouteStatus,
  type ThreadFilesUpdate,
  type AgentPreviewEvent,
} from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { gatewayMessage, type GatewayPayloadInit } from "./messages.ts";
import type { RpcObservation } from "../diagnostics/collector.ts";
import { LogPullClient } from "../diagnostics/log-pull.ts";
import { TraceWorkerClient } from "../diagnostics/trace-worker.ts";
import { WorkerConfigurationCompatibility } from "./configuration-compatibility.ts";

const MAX_BATCH_EVENTS = 32;
const MAX_BATCH_TEXT_BYTES = 256 * 1024;

type KindInit = NonNullable<MessageInitShape<typeof CommandSchema>["kind"]>;

/** One command variant, e.g. `{ case: "unloadThread", value: { threadId } }`. */
export type CommandInit = Exclude<KindInit, { case: undefined }>;

interface PendingCommand {
  promise: Promise<CommandResult>;
  resolve(result: CommandResult): void;
  reject(cause: unknown): void;
  timer: Timer;
  progress?: (progress: CloneProgress) => void;
  queryProgress?: (progress: QueryProgress) => void;
  observation: RpcObservation | undefined;
}

/** One live WorkerLinkService.Connect stream, seen from the gateway. */
export class WorkerConnection {
  readonly workerId: string;
  readonly hello: Hello;
  readonly threadLifecycle = new Map<string, boolean>();
  readonly fileWatches = new Map<string, (update?: ThreadFilesUpdate) => void>();
  readonly previewWatches = new Map<string, (event?: AgentPreviewEvent) => void>();
  registrationEpoch: bigint | undefined;
  projectSecretLeasesReady = false;
  threadLifecycleRevision = 0;
  readonly storageCleaned = new Set<string>();
  /** Scopes the worker deferred (unresolved config/import root); excluded for one offer round to avoid LIMIT starvation. */
  readonly storageCleanupDeferred = new Set<string>();
  storageCleanupPending: { requestId: string; ids: string[]; sentAt: number } | undefined;
  networkRouteStatus: NetworkRouteStatus | undefined;
  sandboxConfigReport: ConfigApplied | undefined;
  /** Worker messages after the handshake. CommandResults matched by sendCommand() are not repeated here. */
  readonly messages: AsyncIterable<WorkerMessage>;
  /** Resolves when the stream ends, for any reason. */
  readonly closed: Promise<void>;
  readonly logSource: LogPullClient;
  readonly tracing: TraceWorkerClient;

  readonly #outbound: AsyncChannel<GatewayMessage>;
  // Some control frames are handled inside deliver() and never reach the core's inbox.
  readonly #firstText = new WeakSet<ThreadEvent>();
  #previousTextThread = "";
  readonly #inbound = new AsyncChannel<WorkerMessage>();
  readonly #pending = new Map<string, PendingCommand>();
  readonly #unpersisted = new Map<string, bigint>();
  readonly #configuration: WorkerConfigurationCompatibility;
  #markClosed!: () => void;

  constructor(
    workerId: string,
    hello: Hello,
    outbound: AsyncChannel<GatewayMessage>,
    readonly observeCommand?: (kind: string) => RpcObservation | undefined,
  ) {
    this.workerId = workerId;
    this.hello = hello;
    this.#configuration = new WorkerConfigurationCompatibility(hello.capabilities);
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

  get idle(): boolean {
    return this.#pending.size === 0 && this.#unpersisted.size === 0 && this.#inbound.queuedItems === 0;
  }

  hasUnpersistedEvents(threadId: string): boolean {
    return this.#unpersisted.has(threadId);
  }

  /** Unknown threads keep their journal on the worker but need no cleanup barrier on this gateway. */
  finishedIngest(threadId: string, through: bigint): void {
    const last = this.#unpersisted.get(threadId);

    if (last !== undefined && through >= last) this.#unpersisted.delete(threadId);
  }

  send(payload: GatewayPayloadInit): void {
    if (payload.case === "eventAck" && payload.value.threadId)
      this.finishedIngest(payload.value.threadId, BigInt(payload.value.ackSeq ?? 0));

    if (!this.#outbound.push(gatewayMessage(payload))) {
      throw new ConnectError(`worker ${this.workerId} is offline`, Code.Unavailable);
    }
  }

  sendConfig(config: MessageInitShape<typeof WorkerConfigSchema>): void {
    this.sandboxConfigReport = undefined;
    this.send({ case: "config", value: this.#configuration.prepare(config) });
  }

  /** Sends a command, preserving its durable outbox id on retries. Concurrent retries share the acknowledgement. */
  sendCommand(
    command: CommandInit,
    timeoutMs = 10_000,
    commandId = Bun.randomUUIDv7(),
    progress?: (progress: CloneProgress) => void,
    queryProgress?: (progress: QueryProgress) => void,
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

    this.#pending.set(commandId, {
      promise,
      resolve,
      reject,
      timer,
      observation,
      ...(progress && { progress }),
      ...(queryProgress && { queryProgress }),
    });

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

  /** Drain only adjacent text deltas already waiting behind this event. */
  eventBatch(first: ThreadEvent): [ThreadEvent, ...ThreadEvent[]] {
    const events: [ThreadEvent, ...ThreadEvent[]] = [first];

    if (first.body.case !== "itemDelta" || first.body.value.field !== ItemDeltaField.TEXT || this.#firstText.has(first))
      return events;
    let textBytes = Buffer.byteLength(first.body.value.chunk) + Buffer.byteLength(first.rawJson);
    let nextSeq = first.journalSeq + 1n;

    while (events.length < MAX_BATCH_EVENTS && textBytes < MAX_BATCH_TEXT_BYTES) {
      const next = this.#inbound.takeIf(({ payload }) => {
        if (payload.case !== "threadEvent") return false;
        const event = payload.value;

        if (
          event.threadId !== first.threadId ||
          event.turnId !== first.turnId ||
          event.journalSeq !== nextSeq ||
          event.body.case !== "itemDelta" ||
          event.body.value.field !== ItemDeltaField.TEXT ||
          this.#firstText.has(event)
        )
          return false;
        textBytes += Buffer.byteLength(event.body.value.chunk) + Buffer.byteLength(event.rawJson);

        return textBytes <= MAX_BATCH_TEXT_BYTES;
      });

      if (next?.payload.case !== "threadEvent") break;
      events.push(next.payload.value);
      nextSeq++;
    }

    return events;
  }

  /** @internal Called by the service for every inbound message. */
  deliver(message: WorkerMessage): void {
    if (message.payload.case === "threadEvent") {
      const event = message.payload.value;
      // A command ACK can otherwise overtake earlier events queued for ingest.
      const { threadId, journalSeq } = event;

      if (journalSeq > (this.#unpersisted.get(threadId) ?? 0n)) this.#unpersisted.set(threadId, journalSeq);
      const text = event.body.case === "itemDelta" && event.body.value.field === ItemDeltaField.TEXT;

      if (text && event.threadId !== this.#previousTextThread) this.#firstText.add(event);
      this.#previousTextThread = text ? event.threadId : "";
    } else this.#previousTextThread = "";

    if (message.payload.case === "configApplied") {
      const report = this.#configuration.report(message.payload.value);
      this.sandboxConfigReport = report;
      this.#inbound.push({
        ...message,
        payload: { case: "configApplied", value: report },
      });

      return;
    }

    if (message.payload.case === "agentPreview") {
      this.previewWatches.get(message.payload.value.previewId)?.(message.payload.value);

      return;
    }

    if (message.payload.case === "threadFilesUpdate") {
      this.fileWatches.get(message.payload.value.subscriptionId)?.(message.payload.value);

      return;
    }

    if (message.payload.case === "diagnosticsTraceReply") {
      this.tracing.receive(message.payload.value);

      return;
    }

    if (message.payload.case === "diagnosticsLogReply") {
      this.logSource.receive(message.payload.value);

      return;
    }

    if (message.payload.case === "queryProgress") {
      this.#pending.get(message.payload.value.commandId)?.queryProgress?.(message.payload.value);

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

    for (const close of this.fileWatches.values()) close();
    this.fileWatches.clear();

    for (const close of this.previewWatches.values()) close();
    this.previewWatches.clear();
    this.#markClosed();
  }
}
