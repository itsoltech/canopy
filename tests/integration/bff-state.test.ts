import { expect, test } from "bun:test";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { startGrpcServer } from "@canopy/transport";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { onBffTargetChange, setBffTarget } from "@canopy/domain/bff-target";
import { QueryCacheDisposed } from "@canopy/domain/shared-query";
import { BffSession, type BffEvent } from "../../apps/web/src/lib/server/bff-state.ts";
import { eventually, startTestGateway } from "./support/gateway.ts";

/** Reads a renderer stream until the selected heads arrive; also reports the revisions of snapshots on the way. */
async function selectedHeads(stream: AsyncGenerator<BffEvent>, ids: readonly string[]) {
  const snapshots: number[] = [];

  for (;;) {
    const next = await stream.next();

    if (next.done) throw new Error("BFF subscription ended before the selected thread heads arrived");
    const event = next.value;

    if (event.kind !== "overview") continue;

    if (event.update.change.case === "mobileSnapshot") snapshots.push(event.revision);

    if (event.update.change.case !== "threadHeads") continue;
    const heads = event.update.change.value.heads;

    if (heads.length === ids.length && ids.every((id) => heads.some((head) => head.threadId === id)))
      return { heads, snapshots };
  }
}

test("thread navigation uses GetThread during overview recovery and the shared snapshot once ready", async () => {
  const snapshot = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const id = crypto.randomUUID();
  let reads = 0;

  const server = await startGrpcServer({
    routes: (router) =>
      router.service(ui.GatewayService, {
        async *watchOverview(_request, context) {
          context.signal.addEventListener("abort", () => stopped.resolve(), { once: true });
          await snapshot.promise;
          yield create(ui.OverviewUpdateSchema, {
            change: {
              case: "mobileSnapshot",
              value: { overview: {}, settings: {}, threads: [{ id, title: "From overview" }] },
            },
          });
          await stopped.promise;
        },
        getThread(request) {
          reads++;

          return create(ui.GetThreadResponseSchema, { thread: { id: request.threadId, title: "From GetThread" } });
        },
      }),
  });

  const session = new BffSession(createClient(ui.GatewayService, createGrpcTransport({ baseUrl: server.url })));
  const signal = AbortSignal.timeout(5000);

  try {
    expect((await session.thread(id, signal)).thread?.title).toBe("From GetThread");
    snapshot.resolve();
    await session.overview.overview();
    expect((await session.thread(id, signal)).thread?.title).toBe("From overview");
    expect(reads).toBe(1);
  } finally {
    snapshot.resolve();
    stopped.resolve();
    session.close();
    await server.close();
  }
});

test.skipIf(!dockerAvailable)(
  "a renderer selection change keeps its stream and overview watch, while an upstream gap still resyncs",
  async () => {
    const gateway = await startTestGateway();
    const overviewRequests: string[][] = [];
    const headRequests: string[][] = [];
    let drop = new AbortController();

    const session = new BffSession({
      ...gateway.api,
      watchOverview(request, options) {
        overviewRequests.push([...(request.threadHeadIds ?? [])]);
        const signal = AbortSignal.any([...(options?.signal ? [options.signal] : []), drop.signal]);

        return gateway.api.watchOverview(request, { ...options, signal });
      },
      watchThreadHeads(request, options) {
        headRequests.push([...(request.threadIds ?? [])]);

        return gateway.api.watchThreadHeads(request, options);
      },
    });

    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]);
    let stream: AsyncGenerator<BffEvent> | undefined;
    let replacement: AsyncGenerator<BffEvent> | undefined;

    try {
      const projectId = (await gateway.api.createProject({ name: "Renderer navigation" })).project!.id;

      const workspaceId = (
        await gateway.api.createWorkspace({ projectId, workerId: gateway.workerId, rootPath: "/repo/navigation" })
      ).workspace!.id;

      const thread = { projectId, workspaceId, provider: Provider.CODEX };
      const first = (await gateway.api.createThread({ ...thread, title: "First" })).thread!.id;
      const second = (await gateway.api.createThread({ ...thread, title: "Second" })).thread!.id;
      const both = [first, second].sort();
      stream = session.subscribe(both, first, signal);
      const opened = await stream.next();
      const subscription = opened.value?.kind === "subscription" ? opened.value.id : "";
      expect(subscription).toMatch(/^[0-9a-f-]{36}$/);
      const { heads: initial, snapshots } = await selectedHeads(stream, both);
      expect(snapshots).toEqual([0]);
      expect(session.warming.warmer.head(first)).toBeUndefined();
      expect(session.warming.warmer.head(second)).toEqual(initial.find((head) => head.threadId === second));

      // Opening the other thread keeps the head union: only warming follows the new active thread.
      expect(session.select(subscription, both, second)).toBe(true);
      const cursor = initial.find((head) => head.threadId === first)!;
      expect(session.warming.warmer.head(first)?.appliedSeq).toBeGreaterThanOrEqual(cursor.appliedSeq);
      expect(session.warming.warmer.head(second)).toBeUndefined();

      // The previously active thread's background read reaches the shared cache.
      const warmed = await eventually(
        async () => session.warming.cache.peek(first)?.syncCursor,
        (value) => !!value && value.appliedSeq >= cursor.appliedSeq,
      );

      expect(warmed?.threadId).toBe(first);

      // A smaller warm set reopens only the head stream; the renderer stream gets the new heads in place.
      expect(session.select(subscription, [second], second)).toBe(true);
      expect((await selectedHeads(stream, [second])).snapshots).toEqual([]);
      expect(overviewRequests).toEqual([[]]);
      expect(headRequests).toEqual([both, [second]]);
      expect(session.overview.revision).toBe(0);

      // A dropped gateway stream is a gap: the renderer stream ends and its replacement carries a new revision.
      drop.abort();
      drop = new AbortController();

      while (!(await stream.next()).done);
      expect(session.select(subscription, [first], first)).toBe(false);
      replacement = session.subscribe([second], second, signal);
      expect((await replacement.next()).value?.kind).toBe("subscription");
      expect((await selectedHeads(replacement, [second])).snapshots).toEqual([1]);
      expect(overviewRequests).toEqual([[], []]);
    } finally {
      abort.abort();
      await stream?.return(undefined);
      await replacement?.return(undefined);
      session.close();
      await gateway.close();
    }
  },
  30_000,
);

test.skipIf(!dockerAvailable)(
  "target replacement closes shared streams and fences a real private read",
  async () => {
    const gateway = await startTestGateway();
    const previous = globalThis.canopyBffTarget;
    const first = new BffSession(gateway.api);
    let replacement: BffSession | undefined;
    const stop = onBffTargetChange(() => first.close());
    const abort = new AbortController();
    const stream = first.subscribe([], "", abort.signal)[Symbol.asyncIterator]();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    try {
      expect((await stream.next()).value?.kind).toBe("subscription");
      expect((await stream.next()).value?.kind).toBe("overview");
      const project = (await gateway.api.createProject({ name: "BFF target fence" })).project!;

      const workspace = (
        await gateway.api.createWorkspace({
          projectId: project.id,
          workerId: gateway.workerId,
          rootPath: "/repo/bff-state",
        })
      ).workspace!;

      const thread = (
        await gateway.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX })
      ).thread!;

      const pending = first.reads.read(`GetThreadPanel:${thread.id}`, ui.ThreadPanelSchema, async () => {
        const result = await gateway.api.getThreadPanel({ threadId: thread.id });
        started.resolve();
        await release.promise;

        return result;
      });

      const outcome = pending.then(
        () => undefined,
        (cause: unknown) => cause,
      );

      await started.promise;
      setBffTarget({ mode: "offline" });
      expect(await outcome).toBeInstanceOf(QueryCacheDisposed);
      release.resolve();
      expect((await stream.next()).done).toBe(true);
      await expect(first.overview.overview()).rejects.toThrow("closed");
      await expect(
        first.reads.read("ListProxies", ui.ListProxiesResponseSchema, () => gateway.api.listProxies({})),
      ).rejects.toBeInstanceOf(QueryCacheDisposed);
      replacement = new BffSession(gateway.api);
      expect((await replacement.overview.overview()).workers.some((worker) => worker.id === gateway.workerId)).toBe(
        true,
      );
    } finally {
      release.resolve();
      abort.abort();
      stop();
      first.close();
      replacement?.close();
      globalThis.canopyBffTarget = previous;
      await stream.return?.(undefined);
      await gateway.close();
    }
  },
  30_000,
);
