import type { MessageInitShape } from "@bufbuild/protobuf";
import { workerDiagnostics } from "../diagnostics/worker.ts";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  HelloSchema,
  WorkerLinkService,
  type GatewayMessage,
  type Welcome,
  type WorkerMessage,
} from "@canopy/contracts";
import { AsyncChannel, createGrpcClientTransport } from "@canopy/transport";
import { workerMessage, type WorkerPayloadInit } from "./messages.ts";
import { MIN_WORKER_LINK_PROTOCOL, WORKER_LINK_PROTOCOL } from "@canopy/domain/release/protocol";
import { HeartbeatEcho } from "@canopy/domain/diagnostics";

export interface GatewayLinkOptions {
  /** e.g. https://gateway.example.com */
  readonly baseUrl: string;
  readonly credential: string;
  readonly hello: MessageInitShape<typeof HelloSchema>;
  /** Extra trusted CA (PEM) for a self-hosted gateway. */
  readonly ca?: string | Buffer;
  readonly fingerprint?: string;
  readonly pingIntervalMs?: number;
  readonly signal?: AbortSignal;
  /** Durable journals held after a legacy gateway's ingest drain; resumed by a safe Welcome. */
  readonly heldThreads?: readonly string[];
}

/** The worker side of one WorkerLinkService.Connect stream, after a successful handshake. */
export interface GatewayLink {
  readonly welcome: Welcome;
  /** Gateway messages after Welcome. Ends when the stream ends; throws ConnectError on failure. */
  readonly messages: AsyncIterable<GatewayMessage>;
  /** Resolves when the stream ends; carries the error if it ended abnormally. */
  readonly closed: Promise<{ error?: ConnectError }>;
  readonly heldThreads?: ReadonlySet<string>;
  send(payload: WorkerPayloadInit, replay?: boolean): void;
  /** Half-closes the request stream. The gateway ends the call in response. */
  close(): void;
}

/** Opens the bidi stream, sends Hello and waits for Welcome. Rejects with ConnectError on auth/handshake failure. */
export async function openGatewayLink(options: GatewayLinkOptions): Promise<GatewayLink> {
  const transport = createGrpcClientTransport({
    baseUrl: options.baseUrl,
    ...(options.fingerprint && { fingerprint: options.fingerprint }),
    ...(options.ca !== undefined && { ca: options.ca }),
    ...(options.pingIntervalMs !== undefined && { pingIntervalMs: options.pingIntervalMs }),
  });

  const client = createClient(WorkerLinkService, transport);

  const outbound = new AsyncChannel<WorkerMessage>();
  outbound.push(
    workerMessage({
      case: "hello",
      value: {
        workerLinkProtocol: WORKER_LINK_PROTOCOL,
        minWorkerLinkProtocol: MIN_WORKER_LINK_PROTOCOL,
        ...options.hello,
      },
    }),
  );

  const responses = client
    .connect(outbound, {
      headers: { authorization: `Bearer ${options.credential}` },
      ...(options.signal && { signal: options.signal }),
    })
    [Symbol.asyncIterator]();

  let first: IteratorResult<GatewayMessage>;

  try {
    first = await responses.next();
  } catch (error) {
    outbound.close();
    throw ConnectError.from(error);
  }

  if (first.done || first.value.payload.case !== "welcome") {
    outbound.close();
    throw new ConnectError("gateway did not answer Hello with Welcome", Code.FailedPrecondition);
  }

  const inbound = new AsyncChannel<GatewayMessage>();

  const echo =
    first.value.payload.value.diagnosticsV1 && options.hello.capabilities?.includes("diagnostics_v1")
      ? new HeartbeatEcho()
      : undefined;

  const report = echo
    ? setInterval(() => {
        if (outbound.closed) return;
        const value = echo.batch();

        if (
          first.value?.payload.case === "welcome" &&
          first.value.payload.value.workerDiagnosticsV1 &&
          workerDiagnostics.enabled
        )
          workerDiagnostics.measurements.report(value);

        outbound.push(workerMessage({ case: "diagnostics", value }));
      }, 30_000)
    : undefined;

  if (echo && first.value.payload.value.workerDiagnosticsV1) workerDiagnostics.measurements.reset();

  report?.unref();

  const closed = (async (): Promise<{ error?: ConnectError }> => {
    try {
      for (let next = await responses.next(); !next.done; next = await responses.next()) {
        if (next.value.payload.case === "heartbeatEcho") {
          echo?.receive(next.value.payload.value.sequence);
          continue;
        }

        inbound.push(next.value);
      }

      inbound.close();

      return {};
    } catch (cause) {
      const error = ConnectError.from(cause);
      inbound.close(error);

      return { error };
    } finally {
      clearInterval(report);
      outbound.close();
    }
  })();

  const heldThreads = new Set(first.value.payload.value.isolatedEventIngest ? [] : options.heldThreads);

  return {
    welcome: first.value.payload.value,
    messages: inbound,
    closed,
    heldThreads,
    send(payload, replay = false) {
      if (payload.case === "threadEvent" && heldThreads.has(payload.value.threadId ?? "")) return;

      const measured =
        echo && payload.case === "heartbeat"
          ? { ...payload, value: { ...payload.value, echoSequence: echo.send() } }
          : payload;

      if (!outbound.push(workerMessage(measured))) {
        throw new ConnectError("gateway link is closed", Code.Unavailable);
      }

      if (payload.case === "threadEvent")
        workerDiagnostics.sent(payload.value.threadId ?? "", payload.value.journalSeq ?? 0n, replay);
    },
    close: () => outbound.close(),
  };
}
