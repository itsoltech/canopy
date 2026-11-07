import { create, type Message } from "@bufbuild/protobuf";
import { bots, ui } from "@canopy/contracts";
import { qualifyId, REMOTE_BOTS, THREAD_MIRROR } from "@canopy/domain/computers";
import { AsyncChannel } from "@canopy/transport";
import { createHandlerContext, type HandlerContext } from "@connectrpc/connect";
import { linkedMessage, methodNamed } from "../computers/remote.ts";
import type { GatewayCore } from "../core/core.ts";
import { single, stream, unary, unaryTimeout, withSignal, type Handler } from "./routed-context.ts";
import { localProjectIds } from "./routed-config.ts";
import { forward } from "./routed-home.ts";
import { PEER_BACKOFF_MS, PEER_READ_REFRESH_MS } from "../computers/timing.ts";

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

/** Local projections and last-known responses only. Live peer reads refresh in the background. */
export async function gather<A extends Message>(
  core: GatewayCore,
  name: string,
  request: Message,
  signal: AbortSignal,
  unavailable?: ui.LinkedComputer[],
  refreshing?: ui.LinkedComputer[],
): Promise<A[]> {
  const computers = core.computers;
  const method = methodNamed(name)!;

  if (!computers) return [];
  const nodes = new Set(computers.reachable());

  for (const peer of (await computers.snapshot()).peers) if (!peer.relayOrigin) nodes.add(peer.nodeId);

  const ordered = [...nodes];

  const reachable = new Set(computers.reachable());

  const results = await Promise.allSettled(
    ordered.map(async (nodeId) => {
      // Committed local projections stay authoritative through reconnects and partial mirror resets.
      if (
        (name === "GetOverview" || name === "ListThreads") &&
        computers.capabilities(nodeId).includes(THREAD_MIRROR)
      ) {
        const projection = await single<A>(forward(core, nodeId, method, request, signal));

        if (name === "GetOverview") {
          // Older mirror publishers omit picker capabilities. Enrich those fields asynchronously.
          const cached = computers.reads.read<ui.GetOverviewResponse>(
            nodeId,
            method,
            request,
            (background) => single(forward(core, nodeId, method, request, background, false, true)),
            unaryTimeout(method),
            reachable.has(nodeId),
          );

          const overview = linkedMessage(ui.GetOverviewResponseSchema, projection);

          for (const worker of overview.workers) {
            const known = cached?.workers.find((item) => item.id === worker.id);

            if (known) {
              worker.providers = known.providers;
              worker.providerInstances = known.providerInstances;
            }

            // Older mirrors omit public update metadata, including the revision required by edits.
            if (known && known.configVersion > worker.configVersion) {
              worker.configVersion = known.configVersion;
              worker.appliedVersion = known.appliedVersion;
              worker.cliUpdateCheckMinutes = known.cliUpdateCheckMinutes;
              worker.effectiveCliUpdateCheckMinutes = known.effectiveCliUpdateCheckMinutes;
              worker.cliUpdatesCheckedAt = known.cliUpdatesCheckedAt;
              worker.cliUpdatesNextCheckAt = known.cliUpdatesNextCheckAt;
              worker.cliTools = known.cliTools;
            }
          }
        }

        return projection;
      }

      if (!reachable.has(nodeId) && name === "ListBots" && computers.capabilities(nodeId).includes(REMOTE_BOTS)) {
        const projection = await single<A>(forward(core, nodeId, method, request, signal));
        const mirrored = linkedMessage(bots.ListBotsResponseSchema, projection);

        const cached = computers.reads.read<bots.ListBotsResponse>(
          nodeId,
          method,
          request,
          (background) => single(forward(core, nodeId, method, request, background)),
          unaryTimeout(method),
          false,
        );

        const ids = new Set(mirrored.bots.map((bot) => bot.id));
        mirrored.bots.push(...(cached?.bots.filter((bot) => !ids.has(bot.id)) ?? []));

        return projection;
      }

      return computers.reads.read(
        nodeId,
        method,
        request,
        (background) => single<A>(forward(core, nodeId, method, request, background)),
        unaryTimeout(method),
        reachable.has(nodeId),
      );
    }),
  );

  if (unavailable || refreshing)
    for (const [index, result] of results.entries()) {
      const node = ordered[index]!;
      const absent = !reachable.has(node) || computers.reads.blocked(node);
      const state = computers.reads.state(node, method, request);

      if (!absent && result.status === "fulfilled" && state === "fresh") continue;
      const computer = await computers.computer(node);

      if (computer) {
        computer.unavailableReason = absent
          ? (await computers.unavailable(node)).rawMessage
          : `Waiting for ${computer.displayName || computer.name}. Its bot list may be incomplete.`;
        (absent ? unavailable : refreshing)?.push(computer);
      }
    }

  return results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
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
    case "schedule":
      return [update];
    default:
      return [];
  }
}

const BURST_MS = 50;

/**
 * Sends shared projects with every computer's workspaces. A burst (a worker change republishes every project)
 * reads the overview once; if that fails, this computer's own row still goes out.
 */
function sharedProjects(
  core: GatewayCore,
  own: Record<string, Handler>,
  signal: AbortSignal,
  push: (project: ui.Project) => void,
) {
  let pending: Map<string, ui.Project | undefined> | undefined;

  return (ids: Iterable<string>, fallback?: ui.Project) => {
    const batch = pending ?? new Map<string, ui.Project | undefined>();

    for (const id of ids) batch.set(id, fallback ?? batch.get(id));

    if (pending) return;
    pending = batch;

    setTimeout(async () => {
      pending = undefined;

      const projects = await ownOverview(core, own, signal).then(
        (overview) => overview.projects,
        () => [],
      );

      if (signal.aborted) return;

      for (const [id, local] of batch) {
        const value = projects.find((p) => p.id === id) ?? local;

        if (value) push(value);
      }
    }, BURST_MS);
  };
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

  const unsubscribeReads = computers.reads.subscribe((method) =>
    out.push(create(ui.OverviewUpdateSchema, { change: { case: "linkedReadCompleted", value: method } })),
  );

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
          if (merged.size) resend(merged);
        }
      } catch {
        /* the link dropped; its presence change follows */
      } finally {
        if (watchers.get(nodeId) === controller) watchers.delete(nodeId);

        // Another connection to the same computer may still be up.
        if (!signal.aborted && !controller.signal.aborted)
          setTimeout(sync, computers.reads.blocked(nodeId) ? PEER_BACKOFF_MS : PEER_READ_REFRESH_MS);
      }
    })();
  };

  const resend = sharedProjects(core, own, signal, (value) =>
    out.push(create(ui.OverviewUpdateSchema, { change: { case: "project", value } })),
  );

  function sync() {
    if (signal.aborted) return;
    const reachable = new Set(computers!.reachable());

    for (const [nodeId, controller] of watchers)
      if (!reachable.has(nodeId)) {
        controller.abort();
        watchers.delete(nodeId);
      }

    for (const nodeId of reachable) if (!watchers.has(nodeId) && !computers!.reads.blocked(nodeId)) watch(nodeId);
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
        const change = update.change;

        // This computer's row of a shared project alone would hide the other computers' workspaces.
        if (
          change.case === "project" &&
          !change.value.archivedAt &&
          (await localProjectIds(core)).has(change.value.id)
        ) {
          resend([change.value.id], change.value);
          continue;
        }

        if (change.case === "mobileSnapshot" && change.value.overview) {
          // A phone's reconnect snapshot covers every connected computer too.
          const [overviews, lists] = await Promise.all([
            gather<ui.GetOverviewResponse>(core, "GetOverview", create(ui.GetOverviewRequestSchema), signal),
            gather<ui.ListThreadsResponse>(core, "ListThreads", create(ui.ListThreadsRequestSchema), signal),
          ]);

          absorb(change.value.overview, overviews, await localProjectIds(core));
          change.value.overview.computers = (await computers.snapshot()).peers;

          for (const other of lists) change.value.threads.push(...other.threads);
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
    unsubscribeReads();

    for (const controller of watchers.values()) controller.abort();
  }
}
