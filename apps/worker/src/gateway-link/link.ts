import type { MessageInitShape } from "@bufbuild/protobuf";
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
}

/** The worker side of one WorkerLinkService.Connect stream, after a successful handshake. */
export interface GatewayLink {
  readonly welcome: Welcome;
  /** Gateway messages after Welcome. Ends when the stream ends; throws ConnectError on failure. */
  readonly messages: AsyncIterable<GatewayMessage>;
  /** Resolves when the stream ends; carries the error if it ended abnormally. */
  readonly closed: Promise<{ error?: ConnectError }>;
  send(payload: WorkerPayloadInit): void;
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

  const closed = (async (): Promise<{ error?: ConnectError }> => {
    try {
      for (let next = await responses.next(); !next.done; next = await responses.next()) {
        inbound.push(next.value);
      }

      inbound.close();

      return {};
    } catch (cause) {
      const error = ConnectError.from(cause);
      inbound.close(error);

      return { error };
    } finally {
      outbound.close();
    }
  })();

  return {
    welcome: first.value.payload.value,
    messages: inbound,
    closed,
    send(payload) {
      if (!outbound.push(workerMessage(payload))) {
        throw new ConnectError("gateway link is closed", Code.Unavailable);
      }
    },
    close: () => outbound.close(),
  };
}
