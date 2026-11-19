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

async function selectedHeads(stream: AsyncGenerator<BffEvent>, ids: readonly string[]) {
  for (;;) {
    const next = await stream.next();

    if (next.done) throw new Error("BFF subscription ended before the selected thread heads arrived");
    const event = next.value;

    if (event.kind !== "overview" || event.update.change.case !== "threadHeads") continue;
    const heads = event.update.change.value.heads;

    if (heads.length === ids.length && ids.every((id) => heads.some((head) => head.threadId === id))) return heads;
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
  "replacing a renderer lease replays cursors and warms the previous thread on the same overview stream",
  async () => {
    const gateway = await startTestGateway();
    const requests: string[][] = [];

    const session = new BffSession({
      ...gateway.api,
      watchOverview(request, options) {
        requests.push([...(request.threadHeadIds ?? [])]);

        return gateway.api.watchOverview(request, options);
      },
    });

    let abort = new AbortController();
    let stream: AsyncGenerator<BffEvent> | undefined;
    const deadline = AbortSignal.timeout(15_000);

    const navigate = async (ids: readonly string[], active: string) => {
      abort.abort();
      await stream?.return(undefined);
      abort = new AbortController();
      await session.overview.overview();
      stream = session.subscribe(ids, active, AbortSignal.any([abort.signal, deadline]));

      return selectedHeads(stream, ids);
    };

    try {
      const projectId = (await gateway.api.createProject({ name: "Renderer navigation" })).project!.id;

      const workspaceId = (
        await gateway.api.createWorkspace({ projectId, workerId: gateway.workerId, rootPath: "/repo/navigation" })
      ).workspace!.id;

      const thread = { projectId, workspaceId, provider: Provider.CODEX };
      const first = (await gateway.api.createThread({ ...thread, title: "First" })).thread!.id;
      const second = (await gateway.api.createThread({ ...thread, title: "Second" })).thread!.id;
      const ids = [first, second];
      const initial = await navigate(ids, first);
      const settled = requests.length;
      expect(session.warming.warmer.head(first)).toBeUndefined();
      expect(session.warming.warmer.head(second)).toEqual(initial.find((head) => head.threadId === second));
      expect(session.warming.seed(first)).toBeUndefined();

      const replay = await navigate(ids, second);
      const cursor = replay.find((head) => head.threadId === first)!;
      expect(cursor.appliedSeq).toBeGreaterThanOrEqual(initial.find((head) => head.threadId === first)!.appliedSeq);
      expect(session.warming.warmer.head(first)).toEqual(cursor);
      expect(session.warming.warmer.head(second)).toBeUndefined();

      // Wait for the previously active thread's background read to reach the shared cache.
      const warmed = await eventually(
        async () => session.warming.cache.peek(first)?.syncCursor,
        (value) => !!value && value.appliedSeq >= cursor.appliedSeq,
      );

      expect(warmed?.threadId).toBe(first);
      expect(warmed?.appliedSeq ?? -1n).toBeGreaterThanOrEqual(cursor.appliedSeq);
      expect(requests.slice(settled)).toEqual([]);

      await navigate([second], second);
      expect(requests.slice(settled)).toEqual([[second]]);
      expect(session.overview.revision).toBe(0);
    } finally {
      abort.abort();
      await stream?.return(undefined);
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
      const initial = await stream.next();
      expect(initial.value?.kind).toBe("overview");
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
      setBffTarget({ gatewayUrl: "http://replacement.invalid", serviceToken: "test-service-token" });
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
