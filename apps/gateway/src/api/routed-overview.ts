import { create, type Message } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { qualifyId, REMOTE_BOTS, THREAD_MIRROR } from "@canopy/domain/computers";
import { AsyncChannel } from "@canopy/transport";
import { createHandlerContext, type HandlerContext } from "@connectrpc/connect";
import { linkedMessage, methodNamed } from "../computers/remote.ts";
import type { GatewayCore } from "../core/core.ts";
import { GATHER_TIMEOUT_MS, single, stream, unary, withSignal, type Handler } from "./routed-context.ts";
import { localProjectIds } from "./routed-config.ts";
import { forward } from "./routed-home.ts";

/** Other computers' overviews in this one. A shared project is listed once, with every computer's workspaces. */
export function absorb(
  overview: { workers: ui.Worker[]; projects: ui.Project[] },
  others: readonly ui.GetOverviewResponse[],
  global: ReadonlySet<string>,
) {
  for (const other of others) {
    overview.workers.push(...other.workers);

    for (const project of other.projects) {
      if (!global.has(project.id)) {
        overview.projects.push(project);
        continue;
      }

      overview.projects.find((p) => p.id === project.id)?.workspaces.push(...project.workspaces);
    }
  }
}

/** The same call on every reachable computer; one that does not answer quickly is left out, not waited for. */
export async function gather<A extends Message>(
  core: GatewayCore,
  name: string,
  request: Message,
  signal: AbortSignal,
): Promise<A[]> {
  const computers = core.computers;
  const method = methodNamed(name)!;

  if (!computers) return [];
  const nodes = new Set(computers.reachable());

  if (name === "GetOverview" || name === "ListThreads" || name === "ListBots")
    for (const peer of (await computers.snapshot()).peers)
      if (peer.capabilities.includes(name === "ListBots" ? REMOTE_BOTS : THREAD_MIRROR)) nodes.add(peer.nodeId);

  const results = await Promise.allSettled(
    [...nodes].map((nodeId) =>
      single<A>(
        forward(core, nodeId, method, request, AbortSignal.any([signal, AbortSignal.timeout(GATHER_TIMEOUT_MS)])),
      ),
    ),
  );

  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

/** Takes shared projects out of another computer's update; returns their ids. */
export function splitShared(update: ui.OverviewUpdate, global: ReadonlySet<string>): Set<string> {
  const merged = new Set<string>();
  const change = update.change;

  if (change.case === "project" && global.has(change.value.id)) {
    merged.add(change.value.id);
    update.change = { case: undefined };
  }

  if (change.case === "mobileSnapshot" && change.value.overview) {
    change.value.overview.projects = change.value.overview.projects.filter(
      (p) => !global.has(p.id) || !merged.add(p.id),
    );
  }

  return merged;
}

/** This computer's overview with every reachable computer's workers, projects and workspaces. */
export async function ownOverview(
  core: GatewayCore,
  own: Record<string, Handler>,
  signal: AbortSignal,
): Promise<ui.GetOverviewResponse> {
  const request = create(ui.GetOverviewRequestSchema);

  const context = createHandlerContext({
    requestSignal: signal,
    service: ui.GatewayService,
    method: ui.GatewayService.method.getOverview,
    protocolName: "canopy.link",
    requestMethod: "POST",
    url: "",
    requestHeader: new Headers(),
    responseHeader: new Headers(),
    responseTrailer: new Headers(),
  });

  const [overview, remote] = await Promise.all([
    // SAFETY: The getOverview entry returns the output of the GetOverview descriptor.
    unary(own["getOverview"]!, request, context) as Promise<ui.GetOverviewResponse>,
    gather<ui.GetOverviewResponse>(core, "GetOverview", request, signal),
  ]);

  absorb(overview, remote, await localProjectIds(core));

  return overview;
}

/** What another computer's overview stream adds here: its workers, projects, threads and models. */
export function remoteUpdates(update: ui.OverviewUpdate, nodeId: string): ui.OverviewUpdate[] {
  const change = update.change;
  const one = (value: ui.OverviewUpdate["change"]) => create(ui.OverviewUpdateSchema, { change: value });

  switch (change.case) {
    case "mobileSnapshot":
      return [
        one({
          case: "computerSnapshot",
          value: create(ui.LinkedComputerSnapshotSchema, {
            nodeId,
            overview: change.value.overview,
            threads: change.value.threads,
          }),
        }),
        // Older UI clients still understand individual upserts.
        ...(change.value.overview?.workers ?? []).map((value) => one({ case: "worker", value })),
        ...(change.value.overview?.projects ?? []).map((value) => one({ case: "project", value })),
        ...change.value.threads.map((value) => one({ case: "thread", value })),
      ];
    case "workerRemoved":
      return [one({ case: "workerRemoved", value: qualifyId(change.value, nodeId) })];
    case "worker":
    case "thread":
    case "project":
    case "models":
      return [update];
    default:
      return [];
  }
}

/** This computer's overview stream, plus a stream from every connected computer and their presence. */
export async function* watchOverview(
  core: GatewayCore,
  own: Record<string, Handler>,
  request: ui.WatchOverviewRequest,
  context: HandlerContext,
): AsyncGenerator<ui.OverviewUpdate> {
  const computers = core.computers;

  if (!computers) {
    // SAFETY: watchOverview is the server-streaming WatchOverview implementation.
    yield* stream(own["watchOverview"]!, request, context) as AsyncIterable<ui.OverviewUpdate>;

    return;
  }

  const out = new AsyncChannel<ui.OverviewUpdate>();
  const stop = new AbortController();
  const signal = AbortSignal.any([context.signal, stop.signal]);
  const watchers = new Map<string, AbortController>();
  const revisions = new Map<string, number>();
  const watchMethod = methodNamed("WatchOverview")!;

  const watch = (nodeId: string) => {
    const controller = new AbortController();
    watchers.set(nodeId, controller);
    void (async () => {
      try {
        const remote = forward(
          core,
          nodeId,
          watchMethod,
          create(ui.WatchOverviewRequestSchema, { includeSnapshot: true }),
          AbortSignal.any([signal, controller.signal]),
        );

        for await (const message of remote) {
          if (signal.aborted || controller.signal.aborted || watchers.get(nodeId) !== controller) break;
          const update = linkedMessage(ui.OverviewUpdateSchema, message);
          const merged = splitShared(update, await localProjectIds(core));

          for (const value of remoteUpdates(update, nodeId)) out.push(value);

          // A shared project is this computer's row: send it again with the other computer's workspaces.
          if (merged.size)
            void ownOverview(core, own, signal)
              .then((overview) => {
                if (signal.aborted || controller.signal.aborted || watchers.get(nodeId) !== controller) return;

                for (const value of overview.projects)
                  if (merged.has(value.id))
                    out.push(create(ui.OverviewUpdateSchema, { change: { case: "project", value } }));
              })
              .catch(() => {});
        }
      } catch {
        /* the link dropped; its presence change follows */
      } finally {
        if (watchers.get(nodeId) === controller) watchers.delete(nodeId);

        // Another connection to the same computer may still be up.
        if (!signal.aborted && !controller.signal.aborted) setTimeout(sync, 1000);
      }
    })();
  };

  function sync() {
    if (signal.aborted) return;
    const reachable = new Set(computers!.reachable());

    for (const [nodeId, controller] of watchers)
      if (!reachable.has(nodeId)) {
        controller.abort();
        watchers.delete(nodeId);
      }

    for (const nodeId of reachable) if (!watchers.has(nodeId)) watch(nodeId);
  }

  const unsubscribe = computers.subscribe(({ nodeId, removed }) => {
    const revision = (revisions.get(nodeId) ?? 0) + 1;
    revisions.set(nodeId, revision);

    if (removed) out.push(create(ui.OverviewUpdateSchema, { change: { case: "computerRemoved", value: nodeId } }));
    else
      void computers
        .computer(nodeId)
        .then((value) => {
          if (value && !signal.aborted && revisions.get(nodeId) === revision)
            out.push(create(ui.OverviewUpdateSchema, { change: { case: "computer", value } }));
        })
        .catch(() => {});
    sync();
  });

  void (async () => {
    try {
      for await (const message of stream(own["watchOverview"]!, request, withSignal(context, signal))) {
        const update = linkedMessage(ui.OverviewUpdateSchema, message);

        if (update.change.case === "mobileSnapshot" && update.change.value.overview) {
          // A phone's reconnect snapshot covers every connected computer too.
          const [overviews, lists] = await Promise.all([
            gather<ui.GetOverviewResponse>(core, "GetOverview", create(ui.GetOverviewRequestSchema), signal),
            gather<ui.ListThreadsResponse>(core, "ListThreads", create(ui.ListThreadsRequestSchema), signal),
          ]);

          absorb(update.change.value.overview, overviews, await localProjectIds(core));
          update.change.value.overview.computers = (await computers.snapshot()).peers;

          for (const other of lists) update.change.value.threads.push(...other.threads);
        }

        out.push(update);
      }

      out.close();
    } catch (error) {
      out.close(error);
    }
  })();

  sync();

  try {
    yield* out;
  } finally {
    stop.abort();
    unsubscribe();

    for (const controller of watchers.values()) controller.abort();
  }
}
