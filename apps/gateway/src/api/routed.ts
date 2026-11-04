import { clone, create, type DescMethod, type Message } from "@bufbuild/protobuf";
import { Code, ConnectError, createContextValues, type HandlerContext } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { qualifyId, splitId, THREAD_MIRROR } from "@canopy/domain/computers";
import { AsyncChannel } from "@canopy/transport";
import type { GatewayCore } from "../core/core.ts";
import { methodNamed, nodesOf, qualify, SERVED, unqualify, type RemoteServe } from "../computers/remote.ts";
import { toConnectError, type UiHandlers } from "./ui-service.ts";

/**
 * Threads of linked computers in this gateway's API (docs/linked-computers.md, stage 2). A request whose
 * ids carry another computer's suffix goes to that computer over the link, and the answer comes back
 * with its ids qualified, so the browser and phone keep using one GatewayService. The overview, thread
 * list and model catalog add every connected computer's own. The home applies every action; this
 * gateway keeps a read-only mirror for offline reads and never queues a call for a disconnected peer.
 */
const UNARY_TIMEOUT_MS = 30_000;
const GATHER_TIMEOUT_MS = 3_000;

type Handler = (request: Message, context: HandlerContext) => unknown;
const unary = (handler: Handler, request: Message, context: HandlerContext) => handler(request, context) as Promise<Message>;
const stream = (handler: Handler, request: Message, context: HandlerContext) => handler(request, context) as AsyncIterable<Message>;
const withSignal = (context: HandlerContext, signal: AbortSignal): HandlerContext => Object.create(context, { signal: { value: signal } });

async function single<A extends Message>(messages: AsyncIterable<Message>): Promise<A> {
  for await (const message of messages) return message as A;
  throw new ConnectError("The other computer sent no answer", Code.Internal);
}

/** The computer a routed request belongs to (its id suffix), or undefined for this computer. */
function target(method: DescMethod, request: Message): string | undefined {
  const nodes = nodesOf(method.input, request);
  if (nodes.size > 1) throw new ConnectError("Choose a project, worker and thread on the same computer", Code.InvalidArgument);
  return [...nodes][0];
}

export function routed(core: GatewayCore, local: UiHandlers): UiHandlers {
  const own = local as unknown as Record<string, Handler>;
  const handlers: Record<string, Handler> = {};
  for (const method of ui.GatewayService.methods) {
    const handler = own[method.localName]!;
    if (!SERVED.has(method.name)) {
      // Settings, credentials and administration stay per computer in this stage.
      const refuse = (request: Message) => {
        if (nodesOf(method.input, request, true).size) throw new ConnectError("This isn't available for threads on another computer yet", Code.FailedPrecondition);
      };
      handlers[method.localName] = method.methodKind === "unary"
        ? (request, context) => { refuse(request); return handler(request, context); }
        : async function* (request, context) { refuse(request); yield* stream(handler, request, context); };
      continue;
    }
    handlers[method.localName] = method.methodKind === "unary"
      ? async (request, context) => {
        const node = target(method, request);
        if (!node) return unary(handler, request, context);
        return single(forward(core, await peerOf(core, node), method, request, AbortSignal.any([context.signal, AbortSignal.timeout(UNARY_TIMEOUT_MS)])));
      }
      : async function* (request, context) {
        const node = target(method, request);
        if (!node) yield* stream(handler, request, context);
        else yield* forward(core, await peerOf(core, node), method, request, context.signal);
      };
  }
  const routedOne = handlers as Record<string, Handler>;
  const overrides: Partial<UiHandlers> = {
    getOverview: async (request, context) => {
      const [overview, snapshot, remote] = await Promise.all([
        unary(own["getOverview"]!, request, context) as Promise<ui.GetOverviewResponse>,
        core.computers?.snapshot(),
        gather<ui.GetOverviewResponse>(core, "GetOverview", request, context.signal),
      ]);
      for (const other of remote) { overview.workers.push(...other.workers); overview.projects.push(...other.projects); }
      overview.computers = snapshot?.peers ?? [];
      return overview;
    },
    listThreads: async (request, context) => {
      if (target(methodNamed("ListThreads")!, request)) return unary(routedOne["listThreads"]!, request, context) as Promise<ui.ListThreadsResponse>;
      const [list, remote] = await Promise.all([unary(handler("listThreads"), request, context) as Promise<ui.ListThreadsResponse>, gather<ui.ListThreadsResponse>(core, "ListThreads", request, context.signal)]);
      for (const other of remote) list.threads.push(...other.threads);
      return list;
    },
    listModels: async (request, context) => {
      if (target(methodNamed("ListModels")!, request)) return unary(routedOne["listModels"]!, request, context) as Promise<ui.ListModelsResponse>;
      const [list, remote] = await Promise.all([unary(handler("listModels"), request, context) as Promise<ui.ListModelsResponse>, gather<ui.ListModelsResponse>(core, "ListModels", request, context.signal)]);
      for (const other of remote) list.workers.push(...other.workers);
      return list;
    },
    // The archive is paged per computer; other computers' archived threads stay on them in this stage.
    listArchivedThreads: (request, context) => {
      const projectIds = request.projectIds.filter((id) => !splitId(id).node);
      if (request.projectIds.length && !projectIds.length) return create(ui.ListArchivedThreadsResponseSchema);
      return unary(handler("listArchivedThreads"), create(ui.ListArchivedThreadsRequestSchema, { ...request, projectIds }), context) as Promise<ui.ListArchivedThreadsResponse>;
    },
    watchOverview: (request, context) => watchOverview(core, own, request, context),
  };
  return { ...(handlers as unknown as UiHandlers), ...overrides };

  function handler(name: string) { return own[name]!; }
}

async function peerOf(core: GatewayCore, ref: string) {
  if (!core.computers) throw new ConnectError("That computer is no longer linked", Code.NotFound);
  return (await core.computers.resolve(ref)).node_id;
}

/** One call to a thread's home: ids become the home's, attachments uploaded here travel with the message. */
async function* forward(core: GatewayCore, nodeId: string, method: DescMethod, request: Message, signal: AbortSignal): AsyncGenerator<Message> {
  const computers = core.computers;
  if (!computers) throw new ConnectError("That computer is no longer linked", Code.NotFound);
  if (!computers.reachable().includes(nodeId) && computers.capabilities(nodeId).includes(THREAD_MIRROR)) {
    if (method.name === "GetThread" || method.name === "WatchThread") {
      const threadId = splitId((request as ui.GetThreadRequest).threadId).id;
      const snapshot = await computers.mirror.snapshot(nodeId, threadId);
      if (!snapshot?.thread) throw new ConnectError("This thread has not been synced yet. Connect its computer to read it.", Code.Unavailable);
      if (method.name === "GetThread") yield create(ui.GetThreadResponseSchema, { thread: snapshot.thread });
      else {
        // End on any peer/mirror change. The normal UI reconnect opens the live home stream again.
        const changes = new AsyncChannel<void>();
        const unsubscribe = computers.subscribe((c) => { if (c.nodeId === nodeId) changes.close(); });
        const abort = () => changes.close(); signal.addEventListener("abort", abort, { once: true });
        try {
          yield create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: snapshot } });
          if (!signal.aborted && !computers.reachable().includes(nodeId)) for await (const _ of changes) { /* closed by a change */ }
        } finally { unsubscribe(); signal.removeEventListener("abort", abort); }
      }
      return;
    }
    if (method.name === "ListThreads") {
      yield create(ui.ListThreadsResponseSchema, { threads: await computers.mirror.threads(nodeId,
        create(ui.ListThreadsRequestSchema, { ...(request as ui.ListThreadsRequest), projectId: splitId((request as ui.ListThreadsRequest).projectId).id })) });
      return;
    }
    if (method.name === "GetOverview") { yield await computers.mirror.overview(nodeId); return; }
    if (method.name === "GetAttachment" || method.name === "GetThreadBlob") {
      const peer = await computers.computer(nodeId);
      throw new ConnectError(`Available when ${peer?.displayName || peer?.name || "the other computer"} is connected`, Code.Unavailable);
    }
  }
  const outbound = clone(method.input, request);
  await carryAttachments(core, nodeId, method, outbound, signal);
  unqualify(method.input, outbound, nodeId);
  for await (const message of computers.remote(nodeId, method, outbound, signal)) {
    qualify(method.output, message, nodeId);
    yield message;
  }
}

/** The browser uploads to this gateway; a message for another computer's thread brings its files along. */
async function carryAttachments(core: GatewayCore, nodeId: string, method: DescMethod, request: Message, signal: AbortSignal) {
  const field = method.name === "SendMessage" ? "attachmentIds" : method.name === "CreateThread" ? "initialAttachmentIds" : undefined;
  if (!field) return;
  const record = request as unknown as Record<string, string[]>;
  const upload = methodNamed("UploadAttachment")!;
  record[field] = await Promise.all(record[field]!.map(async (id) => {
    if (splitId(id).node) return id;
    let file: ui.GetAttachmentResponse;
    try { file = await core.getAttachment(id, false); } catch (error) { throw toConnectError(error); }
    const sent = await single<ui.UploadAttachmentResponse>(core.computers!.remote(nodeId, upload, create(ui.UploadAttachmentRequestSchema, { name: file.attachment?.name ?? "file", data: file.data }), signal));
    return qualifyId(sent.attachment?.id ?? "", nodeId);
  }));
}

/** The same call on every reachable computer; one that does not answer quickly is left out, not waited for. */
async function gather<A extends Message>(core: GatewayCore, name: string, request: Message, signal: AbortSignal): Promise<A[]> {
  const computers = core.computers;
  const method = methodNamed(name)!;
  if (!computers) return [];
  const nodes = new Set(computers.reachable());
  if (name === "GetOverview" || name === "ListThreads") for (const peer of (await computers.snapshot()).peers)
    if (peer.capabilities.includes(THREAD_MIRROR)) nodes.add(peer.nodeId);
  const results = await Promise.allSettled([...nodes].map((nodeId) =>
    single<A>(forward(core, nodeId, method, request, AbortSignal.any([signal, AbortSignal.timeout(GATHER_TIMEOUT_MS)])))));
  return results.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
}

/** What another computer's overview stream adds here: its workers, projects, threads and models. */
function remoteUpdates(update: ui.OverviewUpdate, nodeId: string): ui.OverviewUpdate[] {
  const change = update.change;
  const one = (value: ui.OverviewUpdate["change"]) => create(ui.OverviewUpdateSchema, { change: value });
  switch (change.case) {
    case "mobileSnapshot": return [one({ case: "computerSnapshot", value: create(ui.LinkedComputerSnapshotSchema, {
      nodeId, overview: change.value.overview, threads: change.value.threads,
    }) }),
      // Older UI clients still understand individual upserts.
      ...(change.value.overview?.workers ?? []).map((value) => one({ case: "worker", value })),
      ...(change.value.overview?.projects ?? []).map((value) => one({ case: "project", value })),
      ...change.value.threads.map((value) => one({ case: "thread", value })),
    ];
    case "workerRemoved": return [one({ case: "workerRemoved", value: qualifyId(change.value, nodeId) })];
    case "worker": case "thread": case "project": case "models": return [update];
    default: return [];
  }
}

/** This computer's overview stream, plus a stream from every connected computer and their presence. */
async function* watchOverview(core: GatewayCore, own: Record<string, Handler>, request: ui.WatchOverviewRequest, context: HandlerContext): AsyncGenerator<ui.OverviewUpdate> {
  const computers = core.computers;
  if (!computers) { yield* stream(own["watchOverview"]!, request, context) as AsyncIterable<ui.OverviewUpdate>; return; }
  const out = new AsyncChannel<ui.OverviewUpdate>();
  const stop = new AbortController();
  const signal = AbortSignal.any([context.signal, stop.signal]);
  const watchers = new Map<string, AbortController>();
  const watchMethod = methodNamed("WatchOverview")!;
  const watch = (nodeId: string) => {
    const controller = new AbortController();
    watchers.set(nodeId, controller);
    void (async () => {
      try {
        const remote = forward(core, nodeId, watchMethod, create(ui.WatchOverviewRequestSchema, { includeSnapshot: true }), AbortSignal.any([signal, controller.signal]));
        for await (const update of remote) for (const value of remoteUpdates(update as ui.OverviewUpdate, nodeId)) out.push(value);
      } catch { /* the link dropped; its presence change follows */ }
      finally {
        if (watchers.get(nodeId) === controller) watchers.delete(nodeId);
        // Another connection to the same computer may still be up.
        if (!signal.aborted && !controller.signal.aborted) setTimeout(sync, 1000);
      }
    })();
  };
  function sync() {
    if (signal.aborted) return;
    const reachable = new Set(computers!.reachable());
    for (const [nodeId, controller] of watchers) if (!reachable.has(nodeId)) { controller.abort(); watchers.delete(nodeId); }
    for (const nodeId of reachable) if (!watchers.has(nodeId)) watch(nodeId);
  }
  const unsubscribe = computers.subscribe(({ nodeId, removed }) => {
    if (removed) out.push(create(ui.OverviewUpdateSchema, { change: { case: "computerRemoved", value: nodeId } }));
    else void computers.computer(nodeId).then((value) => { if (value) out.push(create(ui.OverviewUpdateSchema, { change: { case: "computer", value } })); }).catch(() => {});
    sync();
  });
  void (async () => {
    try {
      for await (const update of stream(own["watchOverview"]!, request, withSignal(context, signal)) as AsyncIterable<ui.OverviewUpdate>) {
        if (update.change.case === "mobileSnapshot" && update.change.value.overview) {
          // A phone's reconnect snapshot covers every connected computer too.
          const [overviews, lists] = await Promise.all([
            gather<ui.GetOverviewResponse>(core, "GetOverview", create(ui.GetOverviewRequestSchema), signal),
            gather<ui.ListThreadsResponse>(core, "ListThreads", create(ui.ListThreadsRequestSchema), signal),
          ]);
          for (const other of overviews) { update.change.value.overview.workers.push(...other.workers); update.change.value.overview.projects.push(...other.projects); }
          update.change.value.overview.computers = (await computers.snapshot()).peers;
          for (const other of lists) update.change.value.threads.push(...other.threads);
        }
        out.push(update);
      }
      out.close();
    } catch (error) { out.close(error); }
  })();
  sync();
  try { yield* out; } finally {
    stop.abort();
    unsubscribe();
    for (const controller of watchers.values()) controller.abort();
  }
}

/** Serves a linked computer's call with this computer's own handlers: no routing onward, no aggregation. */
export function remoteServe(local: UiHandlers): RemoteServe {
  const own = local as unknown as Record<string, Handler>;
  return async function* (method, request, signal) {
    const context = { signal, values: createContextValues(), requestHeader: new Headers(), responseHeader: new Headers(), responseTrailer: new Headers(),
      method, service: ui.GatewayService, protocolName: "canopy.link", requestMethod: "POST", url: "" } as unknown as HandlerContext;
    try {
      if (method.methodKind === "unary") yield create(method.output, await unary(own[method.localName]!, request, context));
      else for await (const message of stream(own[method.localName]!, request, context)) yield create(method.output, message);
    } catch (error) { throw toConnectError(error); }
  };
}
