import { fromBinary, toBinary, ScalarType, type DescMessage, type DescMethod, type Message, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { computerLink as link, MentionKind, ui } from "@canopy/contracts";
import { qualifyId, splitId, nodeRef } from "@canopy/domain/computers";
import { AsyncChannel } from "@canopy/transport";

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

/** Explicit home operations for threads and bots, plus capability-gated internal services.
 * Credential and connector administration are never exposed through this allowlist. */
export const SERVED = new Set([
  "GetOverview", "WatchOverview", "ListThreads", "GetThread", "WatchThread", "CreateThread", "SendMessage", "InterruptThread",
  "AnswerInteraction", "UpdateThread", "RegenerateTitle", "SetGoal", "StopBackgroundTask", "MarkThreadSeen", "SetThreadRead",
  "SetThreadArchived", "DeleteThread", "RestoreThread", "ListModels", "ListDirectory", "GetAttachment", "UploadAttachment",
  "GetThreadBlob", "ReorderQueuedTurns", "EditQueuedTurn", "DeleteQueuedTurn", "RestoreQueuedTurn", "SteerQueuedTurn",
  "ListMentionCatalog", "SearchFiles", "WatchThreadMirror", "PushSharedConfig",
  "ListBots", "GetBot", "WatchBotConversation", "SendBotMessage", "AnswerBotApproval", "UpdateBot",
  "InterruptBot", "RetryBot", "MarkBotRead", "ArchiveBot", "UnarchiveBot", "DeleteBot", "ReadBotExchange",
  "SetBotRoutineEnabled", "DeleteBotRoutine", "CancelBotReminder", "WatchBotMirror", "CallAgentBus", "GetBotProviderInstances",
]);
export const methodNamed = (name: string) => ui.GatewayService.methods.find((m) => m.name === name)
  ?? link.ThreadMirrorService.methods.find((m) => m.name === name) ?? link.SharedConfigService.methods.find((m) => m.name === name)
  ?? link.LinkedAgentsService.methods.find((m) => m.name === name);

export const BOT_METHODS = new Set(["ListBots", "GetBot", "WatchBotConversation", "SendBotMessage", "AnswerBotApproval", "UpdateBot",
  "InterruptBot", "RetryBot", "MarkBotRead", "ArchiveBot", "UnarchiveBot", "DeleteBot", "ReadBotExchange",
  "SetBotRoutineEnabled", "DeleteBotRoutine", "CancelBotReminder", "WatchBotMirror", "GetBotProviderInstances"]);

/** Routing metadata is fixed for every chunk of a call. It is never inferred from payload ids. */
export type RelayRoute = { targetNodeId: string; originNodeId: string; relayHops: number };
export const DIRECT_ROUTE: RelayRoute = { targetNodeId: "", originNodeId: "", relayHops: 0 };
export type RemoteServe = (method: DescMethod, request: Message, signal: AbortSignal, peerNodeId?: string, route?: RelayRoute) => AsyncIterable<Message>;
type Frame = MessageInitShape<typeof link.LinkFrameSchema>;

// ------------------------------------------------------------------ ids

const idField = (name: string) => name === "id" || name.endsWith("_id") || name.endsWith("_ids");
const STAMPED = new Set(["canopy.ui.v1.Thread", "canopy.ui.v1.Worker", "canopy.ui.v1.Project", "canopy.ui.v1.Bot"]);

/** Rewrites every id-like string field (`id`, `*_id`, `*_ids`) of a message in place, recursively. */
export function mapIds(desc: DescMessage, message: Message, map: (id: string, field: string) => string, visit?: (desc: DescMessage, message: Record<string, unknown>) => void): void {
  const record = message as unknown as Record<string, unknown>;
  visit?.(desc, record);
  if (desc.typeName === "canopy.worker.v1.Mention" && [MentionKind.BOT, MentionKind.THREAD, MentionKind.CONNECTOR].includes(record["kind"] as MentionKind)) {
    record["name"] = map(String(record["name"]), "mention_id");
  }
  for (const field of desc.fields) {
    let holder = record; let key = field.localName;
    if (field.oneof) {
      const oneof = record[field.oneof.localName] as { case?: string; value?: unknown } | undefined;
      if (oneof?.case !== field.localName) continue;
      holder = oneof as Record<string, unknown>; key = "value";
    }
    const value = holder[key];
    if (field.fieldKind === "scalar" && field.scalar === ScalarType.STRING && idField(field.name) && typeof value === "string" && value) holder[key] = map(value, field.name);
    else if (field.fieldKind === "list" && field.listKind === "scalar" && field.scalar === ScalarType.STRING && idField(field.name)) holder[key] = (value as string[]).map((v) => map(v, field.name));
    else if (field.fieldKind === "list" && field.listKind === "message") for (const item of value as Message[]) mapIds(field.message, item, map, visit);
    else if (field.fieldKind === "message" && value) mapIds(field.message, value as Message, map, visit);
    else if (field.fieldKind === "map" && field.mapKind === "message") for (const item of Object.values(value as Record<string, Message>)) mapIds(field.message, item, map, visit);
  }
}

/** Ids from the home become unambiguous here; threads, workers and projects say which computer they live on. */
export function qualify(desc: DescMessage, message: Message, nodeId: string): void {
  mapIds(desc, message, (id) => qualifyId(id, nodeId), (d, record) => { if (STAMPED.has(d.typeName)) record["nodeId"] = nodeId; });
}

/** A shared project is one identity on every computer: its home-qualified id becomes the plain one. */
export function globalize(desc: DescMessage, message: Message, global: ReadonlySet<string>): void {
  if (!global.size) return;
  mapIds(desc, message, (id) => { const { id: plain, node } = splitId(id); return node && global.has(plain) ? plain : id; });
}

/** The computers a request's ids point at (empty: all local). */
export function nodesOf(desc: DescMessage, message: Message, topLevelOnly = false): Set<string> {
  const nodes = new Set<string>();
  if (topLevelOnly) {
    for (const field of desc.fields) {
      const value = (message as unknown as Record<string, unknown>)[field.localName];
      if (field.fieldKind === "scalar" && idField(field.name) && typeof value === "string") { const { node } = splitId(value); if (node) nodes.add(node); }
    }
    return nodes;
  }
  mapIds(desc, message, (id) => { const { node } = splitId(id); if (node) nodes.add(node); return id; });
  return nodes;
}

/**
 * A request for the home: its own ids, nothing of this or any third computer (no transitive sharing yet).
 * `global`: ids that are the same on every computer (shared projects, stage 4) pass unchanged.
 */
export function unqualify(desc: DescMessage, message: Message, nodeId: string, global: ReadonlySet<string> = new Set()): void {
  mapIds(desc, message, (id, field) => {
    const { id: plain, node } = splitId(id);
    if (node === nodeRef(nodeId)) return plain;
    if (!node && global.has(id)) return id;
    if (node || (field !== "client_request_id" && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)))
      throw new ConnectError("Choose a project, worker and thread on the same computer", Code.InvalidArgument);
    return id;
  });
}

// ------------------------------------------------------------------ calls over one connection

function* chunks(bytes: Uint8Array): Generator<{ data: Uint8Array; more: boolean }> {
  if (!bytes.length) { yield { data: bytes, more: false }; return; }
  for (let at = 0; at < bytes.length; at += CHUNK) yield { data: bytes.subarray(at, at + CHUNK), more: at + CHUNK < bytes.length };
}
function join(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
/** Only Connect's own codes cross; anything else is an internal error without details. */
function wireError(error: unknown): { code: number; message: string } {
  if (error instanceof ConnectError && error.code > 0 && error.code <= 16) return { code: error.code, message: error.rawMessage.slice(0, 500) };
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
  constructor(private readonly options: { send: (frame: Frame) => void; serve?: RemoteServe | undefined; name: () => string; allowed: () => Promise<boolean> }) {}

  get closed() { return this.#closed; }

  async *call(method: DescMethod, request: Message, signal: AbortSignal, route: RelayRoute = DIRECT_ROUTE): AsyncGenerator<Message> {
    if (this.#closed) throw new ConnectError(`${this.options.name()} disconnected`, Code.Unavailable);
    const id = this.#next++;
    const channel = new AsyncChannel<Uint8Array>();
    this.#outgoing.set(id, { channel, parts: [], size: 0 });
    const stop = () => channel.close(signal.reason instanceof ConnectError ? signal.reason : new ConnectError(`${this.options.name()} did not answer in time`, Code.DeadlineExceeded));
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (signal.aborted) { stop(); signal.throwIfAborted(); }
      for (const { data, more } of chunks(toBinary(method.input, request))) this.options.send({ body: { case: "remoteRequest", value: { callId: id, method: method.name, payload: data, more, ...route } } });
      for await (const bytes of channel) yield fromBinary(method.output, bytes);
    } finally {
      signal.removeEventListener("abort", stop);
      // Still registered: the caller stopped before the end. The home aborts its side.
      if (this.#outgoing.delete(id) && !this.#closed) this.options.send({ body: { case: "remoteCancel", value: { callId: id } } });
    }
  }

  receive(body: link.LinkFrame["body"]) {
    if (body.case === "remoteResponse") this.#response(body.value);
    else if (body.case === "remoteRequest") this.#request(body.value);
    else if (body.case === "remoteCancel") { this.#served.get(body.value.callId)?.abort?.abort(); this.#served.delete(body.value.callId); }
  }

  #response(r: link.RemoteResponse) {
    const call = this.#outgoing.get(r.callId);
    if (!call) return;
    if (r.end) {
      this.#outgoing.delete(r.callId);
      call.channel.close(r.code ? new ConnectError(r.message, r.code in Code ? r.code : Code.Internal) : undefined);
      return;
    }
    call.size += r.payload.length;
    if (call.size > MAX_MESSAGE) { call.channel.close(new ConnectError("Response is too large", Code.ResourceExhausted)); return; }
    call.parts.push(r.payload);
    if (!r.more) { call.channel.push(join(call.parts)); call.parts = []; call.size = 0; }
  }

  #request(r: link.RemoteRequest) {
    let call = this.#served.get(r.callId);
    if (call?.abort) return;
    if (!call) {
      if (this.#served.size >= MAX_SERVED) { this.#end(r.callId, { code: Code.ResourceExhausted, message: "Too many calls from this computer at once" }); return; }
      call = { method: r.method, route: { targetNodeId: r.targetNodeId, originNodeId: r.originNodeId, relayHops: r.relayHops }, parts: [], size: 0 };
      this.#served.set(r.callId, call);
    }
    if (call.method !== r.method || call.route.targetNodeId !== r.targetNodeId || call.route.originNodeId !== r.originNodeId || call.route.relayHops !== r.relayHops) {
      this.#served.delete(r.callId); this.#end(r.callId, { code: Code.InvalidArgument, message: "Call routing changed between chunks" }); return;
    }
    call.size += r.payload.length;
    if (call.size > MAX_MESSAGE) { this.#served.delete(r.callId); this.#end(r.callId, { code: Code.ResourceExhausted, message: "Request is too large" }); return; }
    call.parts.push(r.payload);
    if (r.more) return;
    const abort = new AbortController(); call.abort = abort;
    const bytes = join(call.parts); call.parts = [];
    void this.#serve(r.callId, call.method, bytes, abort.signal, call.route).finally(() => { if (this.#served.get(r.callId) === call) this.#served.delete(r.callId); });
  }

  async #serve(id: bigint, name: string, bytes: Uint8Array, signal: AbortSignal, route: RelayRoute) {
    try {
      const method = SERVED.has(name) ? methodNamed(name) : undefined;
      if (!method || !this.options.serve) throw new ConnectError("This computer does not share that action", Code.Unimplemented);
      // Unlink closes the connection first; this keeps a race from serving a revoked peer.
      if (!await this.options.allowed()) throw new ConnectError("This computer is no longer linked", Code.PermissionDenied);
      const request = fromBinary(method.input, bytes);
      if (nodesOf(method.input, request).size) throw new ConnectError("Calls through another computer are not supported", Code.InvalidArgument);
      for await (const message of this.options.serve(method, request, signal, undefined, route)) {
        if (signal.aborted || this.#closed) return;
        for (const { data, more } of chunks(toBinary(method.output, message))) this.options.send({ body: { case: "remoteResponse", value: { callId: id, payload: data, more } } });
      }
      if (!signal.aborted) this.#end(id);
    } catch (error) {
      if (!signal.aborted) this.#end(id, wireError(error));
    }
  }

  #end(id: bigint, error?: { code: number; message: string }) {
    if (!this.#closed) this.options.send({ body: { case: "remoteResponse", value: { callId: id, end: true, ...error } } });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const call of this.#outgoing.values()) call.channel.close(new ConnectError(`${this.options.name()} disconnected`, Code.Unavailable));
    this.#outgoing.clear();
    for (const call of this.#served.values()) call.abort?.abort();
    this.#served.clear();
  }
}
