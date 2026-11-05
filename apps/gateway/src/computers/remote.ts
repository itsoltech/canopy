import { fromBinary, toBinary, type DescMethod, type Message, type MessageInitShape } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { Code, ConnectError } from "@connectrpc/connect";
import { nodesOf } from "./remote-ids.ts";
import { methodNamed, MovedError, movedItems, SERVED } from "./remote-policy.ts";

export { mapIds, nodesOf, qualify, unqualify } from "./remote-ids.ts";

export {
  BOT_METHODS,
  linkedMessage,
  methodNamed,
  MOVE_METHODS,
  MovedError,
  movedItems,
  SERVED,
  WORKER_SETTINGS,
} from "./remote-policy.ts";

/**
 * Stage 2 of docs/linked-computers.md: GatewayService calls proxied to a thread's home gateway over the
 * pinned link. Payloads are chunked below the link's 64 KiB frame limit; nothing is queued for a peer
 * that is not connected, and a dropped connection fails every call on it at once.
 */
const CHUNK = 32 * 1024;

/** Reassembled message limit (attachments and transcript blobs are the large ones). */
const MAX_MESSAGE = 48 * 1024 * 1024;

/** Calls one connection may run on this gateway at the same time. */
const MAX_SERVED = 64;

/** Routing metadata is fixed for every chunk of a call. It is never inferred from payload ids. */
export type RelayRoute = { targetNodeId: string; originNodeId: string; relayHops: number };

export const DIRECT_ROUTE: RelayRoute = { targetNodeId: "", originNodeId: "", relayHops: 0 };

export type RemoteServe = (
  method: DescMethod,
  request: Message,
  signal: AbortSignal,
  peerNodeId?: string,
  route?: RelayRoute,
) => AsyncIterable<Message>;

type Frame = MessageInitShape<typeof link.LinkFrameSchema>;

// ------------------------------------------------------------------ calls over one connection

function* chunks(bytes: Uint8Array): Generator<{ data: Uint8Array; more: boolean }> {
  if (!bytes.length) {
    yield { data: bytes, more: false };

    return;
  }

  for (let at = 0; at < bytes.length; at += CHUNK)
    yield { data: bytes.subarray(at, at + CHUNK), more: at + CHUNK < bytes.length };
}

function join(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;

  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }

  return out;
}

/** Only Connect's own codes cross; anything else is an internal error without details. */
function wireError(cause: unknown) {
  const moved = movedItems(cause);

  if (moved && cause instanceof ConnectError)
    return {
      code: cause.code,
      message: cause.rawMessage.slice(0, 500),
      moved: moved.slice(0, 64),
    };

  if (cause instanceof ConnectError && cause.code > 0 && cause.code <= 16)
    return { code: cause.code, message: cause.rawMessage.slice(0, 500) };

  return { code: Code.Internal, message: "internal error" };
}

type Outgoing = { channel: AsyncChannel<Uint8Array>; parts: Uint8Array[]; size: number };

type Served = { method: string; route: RelayRoute; parts: Uint8Array[]; size: number; abort?: AbortController };

/** Both directions of remote calls on one link connection. Call ids are per direction. */
export class RemoteCalls {
  #next = 1n;
  #outgoing = new Map<bigint, Outgoing>();
  #served = new Map<bigint, Served>();
  #closed = false;
  constructor(
    private readonly options: {
      send: (frame: Frame) => void;
      serve?: RemoteServe | undefined;
      name: () => string;
      allowed: () => Promise<boolean>;
    },
  ) {}

  get closed() {
    return this.#closed;
  }

  async *call(
    method: DescMethod,
    request: Message,
    signal: AbortSignal,
    route: RelayRoute = DIRECT_ROUTE,
  ): AsyncGenerator<Message> {
    if (this.#closed) throw new ConnectError(`${this.options.name()} disconnected`, Code.Unavailable);
    const id = this.#next++;
    const channel = new AsyncChannel<Uint8Array>();
    this.#outgoing.set(id, { channel, parts: [], size: 0 });

    const stop = () =>
      channel.close(
        signal.reason instanceof ConnectError
          ? signal.reason
          : new ConnectError(`${this.options.name()} did not answer in time`, Code.DeadlineExceeded),
      );

    signal.addEventListener("abort", stop, { once: true });

    try {
      if (signal.aborted) {
        stop();
        signal.throwIfAborted();
      }

      for (const { data, more } of chunks(toBinary(method.input, request)))
        this.options.send({
          body: { case: "remoteRequest", value: { callId: id, method: method.name, payload: data, more, ...route } },
        });

      for await (const bytes of channel) yield fromBinary(method.output, bytes);
    } finally {
      signal.removeEventListener("abort", stop);

      // Still registered: the caller stopped before the end. The home aborts its side.
      if (this.#outgoing.delete(id) && !this.#closed)
        this.options.send({ body: { case: "remoteCancel", value: { callId: id } } });
    }
  }

  receive(body: link.LinkFrame["body"]) {
    if (body.case === "remoteResponse") this.#response(body.value);
    else if (body.case === "remoteRequest") this.#request(body.value);
    else if (body.case === "remoteCancel") {
      this.#served.get(body.value.callId)?.abort?.abort();
      this.#served.delete(body.value.callId);
    }
  }

  #response(r: link.RemoteResponse) {
    const call = this.#outgoing.get(r.callId);

    if (!call) return;

    if (r.end) {
      this.#outgoing.delete(r.callId);
      call.channel.close(
        r.code
          ? r.moved.length
            ? new MovedError(r.moved, r.message)
            : new ConnectError(r.message, r.code in Code ? r.code : Code.Internal)
          : undefined,
      );

      return;
    }

    call.size += r.payload.length;

    if (call.size > MAX_MESSAGE) {
      call.channel.close(new ConnectError("Response is too large", Code.ResourceExhausted));

      return;
    }

    call.parts.push(r.payload);

    if (!r.more) {
      call.channel.push(join(call.parts));
      call.parts = [];
      call.size = 0;
    }
  }

  #request(r: link.RemoteRequest) {
    let call = this.#served.get(r.callId);

    if (call?.abort) return;

    if (!call) {
      if (this.#served.size >= MAX_SERVED) {
        this.#end(r.callId, { code: Code.ResourceExhausted, message: "Too many calls from this computer at once" });

        return;
      }

      call = {
        method: r.method,
        route: { targetNodeId: r.targetNodeId, originNodeId: r.originNodeId, relayHops: r.relayHops },
        parts: [],
        size: 0,
      };
      this.#served.set(r.callId, call);
    }

    if (
      call.method !== r.method ||
      call.route.targetNodeId !== r.targetNodeId ||
      call.route.originNodeId !== r.originNodeId ||
      call.route.relayHops !== r.relayHops
    ) {
      this.#served.delete(r.callId);
      this.#end(r.callId, { code: Code.InvalidArgument, message: "Call routing changed between chunks" });

      return;
    }

    call.size += r.payload.length;

    if (call.size > MAX_MESSAGE) {
      this.#served.delete(r.callId);
      this.#end(r.callId, { code: Code.ResourceExhausted, message: "Request is too large" });

      return;
    }

    call.parts.push(r.payload);

    if (r.more) return;
    const abort = new AbortController();
    call.abort = abort;
    const bytes = join(call.parts);
    call.parts = [];
    void this.#serve(r.callId, call.method, bytes, abort.signal, call.route).finally(() => {
      if (this.#served.get(r.callId) === call) this.#served.delete(r.callId);
    });
  }

  async #serve(id: bigint, name: string, bytes: Uint8Array, signal: AbortSignal, route: RelayRoute) {
    try {
      const method = SERVED.has(name) ? methodNamed(name) : undefined;

      if (!method || !this.options.serve)
        throw new ConnectError("This computer does not share that action", Code.Unimplemented);

      // Unlink closes the connection first; this keeps a race from serving a revoked peer.
      if (!(await this.options.allowed()))
        throw new ConnectError("This computer is no longer linked", Code.PermissionDenied);
      const request = fromBinary(method.input, bytes);

      if (nodesOf(method.input, request).size)
        throw new ConnectError("Calls through another computer are not supported", Code.InvalidArgument);

      for await (const message of this.options.serve(method, request, signal, undefined, route)) {
        if (signal.aborted || this.#closed) return;

        for (const { data, more } of chunks(toBinary(method.output, message)))
          this.options.send({ body: { case: "remoteResponse", value: { callId: id, payload: data, more } } });
      }

      if (!signal.aborted) this.#end(id);
    } catch (error) {
      if (!signal.aborted) this.#end(id, wireError(error));
    }
  }

  #end(id: bigint, error?: { code: number; message: string; moved?: link.MovedItem[] }) {
    if (!this.#closed)
      this.options.send({ body: { case: "remoteResponse", value: { callId: id, end: true, ...error } } });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;

    for (const call of this.#outgoing.values())
      call.channel.close(new ConnectError(`${this.options.name()} disconnected`, Code.Unavailable));
    this.#outgoing.clear();

    for (const call of this.#served.values()) call.abort?.abort();
    this.#served.clear();
  }
}
