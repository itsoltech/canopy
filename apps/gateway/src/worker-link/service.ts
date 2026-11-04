import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import {
  WelcomeSchema,
  WorkerConfigSchema,
  WorkerLinkService,
  type GatewayMessage,
  type Hello,
  type WorkerMessage,
} from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { MIN_WORKER_LINK_PROTOCOL, WORKER_LINK_PROTOCOL, workerLinkCompatible } from "@canopy/domain/release/protocol";
import { WorkerConnection } from "./connection.ts";
import { gatewayMessage } from "./messages.ts";

export interface WorkerLinkOptions {
  /** Maps a bearer credential to a worker id. Returns undefined when unknown or revoked. */
  authenticate(credential: string): Promise<string | undefined>;
  /** Builds the Welcome for an authenticated Hello (e.g. persisted seq per thread from the DB). */
  welcome(workerId: string, hello: Hello): Promise<MessageInitShape<typeof WelcomeSchema>>;
  /**
   * Remote configuration for the worker (docs/worker-config.md). Sent right after Welcome when the
   * worker does not already hold this version. Undefined = the worker is not configured yet.
   */
  config?(workerId: string): Promise<MessageInitShape<typeof WorkerConfigSchema> | undefined>;
  /** Called after Welcome (and config) are queued. The connection is already registered. */
  onConnected?(connection: WorkerConnection): void;
  helloTimeoutMs?: number;
}

export interface WorkerLink {
  readonly routes: (router: ConnectRouter) => void;
  /** Live connections by worker id. A reconnect replaces (and closes) the previous connection. */
  readonly connections: ReadonlyMap<string, WorkerConnection>;
  /** Pushes a changed configuration to a connected worker. False when the worker is offline (it gets it on connect). */
  pushConfig(workerId: string, config: MessageInitShape<typeof WorkerConfigSchema>): boolean;
  /** Invalidates in-flight handshakes and closes the current stream after a credential change. */
  disconnect(workerId: string): void;
  /**
   * Sends Drain to every worker, then ends their streams cleanly.
   * Workers reconnect after `reconnectAfterMs` plus a per-worker random jitter,
   * so a rolling update does not cause a reconnect storm on the next instance.
   */
  shutdown(options?: DrainOptions): Promise<void>;
}

export interface DrainOptions {
  readonly reason?: string;
  readonly reconnectAfterMs?: number;
  readonly jitterMs?: number;
}

export function createWorkerLink(options: WorkerLinkOptions): WorkerLink {
  const connections = new Map<string, WorkerConnection>();
  let credentialEpoch = 0;
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000;

  async function* connect(requests: AsyncIterable<WorkerMessage>, ctx: HandlerContext): AsyncIterable<GatewayMessage> {
    const epoch = credentialEpoch;
    const credential = bearerToken(ctx.requestHeader.get("authorization"));

    if (!credential) throw new ConnectError("missing worker credential", Code.Unauthenticated);
    const workerId = await options.authenticate(credential);

    if (!workerId) throw new ConnectError("invalid worker credential", Code.Unauthenticated);

    const inbound = requests[Symbol.asyncIterator]();
    const first = await withTimeout(inbound.next(), helloTimeoutMs, ctx.signal);

    if (first.done || first.value.payload.case !== "hello") {
      throw new ConnectError("first message must be Hello", Code.FailedPrecondition);
    }

    const hello = first.value.payload.value;

    if (hello.workerId !== workerId) {
      throw new ConnectError("Hello.worker_id does not match credential", Code.PermissionDenied);
    }

    if (!workerLinkCompatible(hello.minWorkerLinkProtocol, hello.workerLinkProtocol)) {
      throw new ConnectError(
        `WorkerLink protocol ${hello.minWorkerLinkProtocol}..${hello.workerLinkProtocol} is incompatible with gateway ${MIN_WORKER_LINK_PROTOCOL}..${WORKER_LINK_PROTOCOL}; use canopy.update.v1.UpdateService to update`,
        Code.FailedPrecondition,
      );
    }

    const outbound = new AsyncChannel<GatewayMessage>();
    outbound.push(gatewayMessage({ case: "welcome", value: await options.welcome(workerId, hello) }));
    const config = await options.config?.(workerId);

    if (config && BigInt(config.version ?? 0) !== hello.configVersion) {
      outbound.push(gatewayMessage({ case: "config", value: config }));
    }

    // No await between this check and registration: a rotation/revoke cannot leave a stale handshake live.
    if (epoch !== credentialEpoch)
      throw new ConnectError("worker credentials changed; reconnect", Code.Unauthenticated);
    const connection = new WorkerConnection(workerId, hello, outbound);
    connections.get(workerId)?.close();
    connections.set(workerId, connection);
    void connection.closed.then(() => {
      if (connections.get(workerId) === connection) connections.delete(workerId);
    });
    ctx.signal.addEventListener("abort", () => connection.finish(undefined), { once: true });

    // Inbound pump runs alongside the outbound generator below.
    void (async () => {
      try {
        for (let next = await inbound.next(); !next.done; next = await inbound.next()) {
          connection.deliver(next.value);
        }

        connection.finish(undefined);
      } catch (error) {
        connection.finish(error);
      }
    })();

    options.onConnected?.(connection);
    yield* outbound;
  }

  return {
    routes: (router) => router.service(WorkerLinkService, { connect }),
    connections,
    disconnect: (workerId) => {
      credentialEpoch++;
      connections.get(workerId)?.close();
      connections.delete(workerId);
    },
    pushConfig: (workerId, config) => {
      const connection = connections.get(workerId);

      if (!connection?.isOpen) return false;
      connection.send({ case: "config", value: config });

      return true;
    },
    shutdown: async ({ reason = "gateway shutting down", reconnectAfterMs = 1_000, jitterMs = 4_000 } = {}) => {
      const open = [...connections.values()];

      for (const connection of open) {
        const delay = reconnectAfterMs + Math.floor(Math.random() * jitterMs);

        if (connection.isOpen) connection.send({ case: "drain", value: { reason, reconnectAfterMs: delay } });
        connection.close();
      }

      await Promise.all(open.map((connection) => connection.closed));
    },
  };
}

function bearerToken(header: string | null): string | undefined {
  const match = header?.match(/^Bearer\s+(\S+)$/i);

  return match?.[1];
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ConnectError("Hello not received in time", Code.DeadlineExceeded)), ms);
    const onAbort = () => reject(new ConnectError("stream aborted", Code.Canceled));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}
