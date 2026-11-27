import { afterEach, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AsyncChannel, startGrpcServer } from "@canopy/transport";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { BffOverview } from "../../apps/web/src/lib/server/bff-overview.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

let gateway: TestGateway | undefined;

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

test("failed initial streams preserve waiting readers and old snapshots load settings once", async () => {
  let attempts = 0;
  let settingsReads = 0;
  let drop = () => {};

  const server = await startGrpcServer({
    routes: (router) =>
      router.service(ui.GatewayService, {
        async *watchOverview(_request, context) {
          if (++attempts === 1) throw new ConnectError("Restart", Code.Unavailable);
          const updates = new AsyncChannel<ui.OverviewUpdate>();
          const close = () => updates.close();
          drop = close;
          context.signal.addEventListener("abort", close, { once: true });

          try {
            yield create(ui.OverviewUpdateSchema, {
              change: {
                case: "mobileSnapshot",
                value: { overview: { projects: [{ id: "visible", name: "Owner data" }] } },
              },
            });
            yield* updates;
          } finally {
            context.signal.removeEventListener("abort", close);
          }
        },
        getSettings() {
          settingsReads++;

          return create(ui.GetSettingsResponseSchema, { user: { version: 7n } });
        },
      }),
  });

  const api = createClient(ui.GatewayService, createGrpcTransport({ baseUrl: server.url }));
  const bff = new BffOverview(api);

  try {
    const [overview, settings] = await Promise.all([bff.overview(), bff.settings()]);
    expect(overview.projects[0]?.id).toBe("visible");
    expect(settings.user?.version).toBe(7n);
    expect(attempts).toBe(2);
    expect(settingsReads).toBe(1);
    expect((await bff.settings()).user?.version).toBe(7n);
    expect(settingsReads).toBe(1);
    expect(bff.revision).toBe(1);

    const abort = new AbortController();
    const subscription = bff.subscribe([crypto.randomUUID()], abort.signal)[Symbol.asyncIterator]();
    await eventually(
      async () => attempts,
      (current) => current === 3,
    );
    expect((await bff.settings()).user?.version).toBe(7n);
    expect(attempts).toBe(3);
    expect(bff.revision).toBe(1);
    drop();
    await eventually(
      async () => bff.revision,
      (current) => current === 2,
    );
    expect((await subscription.next()).done).toBe(true);
    await eventually(
      async () => attempts,
      (current) => current === 4,
    );
    expect((await bff.settings()).user?.version).toBe(7n);
    expect(bff.revision).toBe(2);
    const replacement = bff.subscribe([], abort.signal)[Symbol.asyncIterator]();
    expect((await replacement.next()).value?.change.case).toBe("mobileSnapshot");
    bff.close();
    expect((await replacement.next()).done).toBe(true);
    abort.abort();
    expect(
      await bff.overview().then(
        () => false,
        () => true,
      ),
    ).toBe(true);
  } finally {
    bff.close();
    await server.close();
  }
});

test("worker presence and config issues preserve membership in the live BFF overview", async () => {
  const first = create(ui.WorkerSchema, { id: "first", online: true });
  const second = create(ui.WorkerSchema, { id: "second", online: false });
  const updates = new AsyncChannel<ui.OverviewUpdate>();

  const server = await startGrpcServer({
    routes: (router) =>
      router.service(ui.GatewayService, {
        async *watchOverview(_request, context) {
          const close = () => updates.close();
          context.signal.addEventListener("abort", close, { once: true });

          try {
            yield create(ui.OverviewUpdateSchema, {
              change: { case: "mobileSnapshot", value: { overview: { workers: [first] }, settings: {} } },
            });
            yield* updates;
          } finally {
            context.signal.removeEventListener("abort", close);
          }
        },
      }),
  });

  const bff = new BffOverview(createClient(ui.GatewayService, createGrpcTransport({ baseUrl: server.url })));
  const abort = new AbortController();
  const subscription = bff.subscribe([], abort.signal)[Symbol.asyncIterator]();

  async function publish(change: ui.OverviewUpdate["change"]) {
    updates.push(create(ui.OverviewUpdateSchema, { change }));
    expect((await subscription.next()).value?.change.case).toBe(change.case);

    return (await bff.overview()).workers;
  }

  try {
    expect((await subscription.next()).value?.change.case).toBe("mobileSnapshot");
    expect((await bff.overview()).workers).toEqual([first]);

    const offline = { ...first, online: false };
    expect(await publish({ case: "worker", value: offline })).toEqual([offline]);

    const issue = create(ui.WorkerSchema, {
      id: first.id,
      online: true,
      configIssues: [{ path: "profiles", message: "Invalid configuration", fatal: true }],
    });

    expect(await publish({ case: "worker", value: issue })).toEqual([issue]);
    expect(await publish({ case: "worker", value: second })).toEqual([issue, second]);
    expect(await publish({ case: "workerRemoved", value: second.id })).toEqual([issue]);
    expect(await publish({ case: "workerRemoved", value: first.id })).toEqual([]);
  } finally {
    abort.abort();
    updates.close();
    await subscription.return?.();
    bff.close();
    await server.close();
  }
});

test("materializes and replays an overview snapshot with many project thumbnails", async () => {
  // Thumbnail-sized wire values exercise both the upstream and subscriber byte limits.
  const imageBase64 = "A".repeat(24 * 1024);
  const projects = Array.from({ length: 180 }, (_, index) => ({ id: `project-${index}`, imageBase64 }));
  const updates = new AsyncChannel<ui.OverviewUpdate>();

  const server = await startGrpcServer({
    routes: (router) =>
      router.service(ui.GatewayService, {
        async *watchOverview(_request, context) {
          const close = () => updates.close();
          context.signal.addEventListener("abort", close, { once: true });

          try {
            yield create(ui.OverviewUpdateSchema, {
              change: { case: "mobileSnapshot", value: { overview: { projects }, settings: {} } },
            });
            yield* updates;
          } finally {
            context.signal.removeEventListener("abort", close);
          }
        },
      }),
  });

  const bff = new BffOverview(createClient(ui.GatewayService, createGrpcTransport({ baseUrl: server.url })));
  const abort = new AbortController();
  let subscription: AsyncIterator<ui.OverviewUpdate> | undefined;

  try {
    expect((await bff.overview()).projects.length).toBe(projects.length);
    subscription = bff.subscribe([], abort.signal)[Symbol.asyncIterator]();
    const { value } = await subscription.next();
    const change = value?.change;
    expect(change?.case).toBe("mobileSnapshot");

    if (change?.case === "mobileSnapshot") {
      expect(change.value.overview?.projects.length).toBe(projects.length);
      expect(change.value.overview?.projects.at(-1)?.imageBase64).toBe(imageBase64);
    }
  } finally {
    abort.abort();
    updates.close();
    await subscription?.return?.();
    bff.close();
    await server.close();
  }
});

test.skipIf(!dockerAvailable)("shares one overview stream and serves materialized reads", async () => {
  gateway = await startTestGateway();
  let watchCalls = 0;

  const watchOverview = (...args: Parameters<Client<typeof ui.GatewayService>["watchOverview"]>) => {
    watchCalls++;

    return gateway!.api.watchOverview(...args);
  };

  const api = { watchOverview } satisfies Pick<Client<typeof ui.GatewayService>, "watchOverview">;
  // SAFETY: BffOverview only calls watchOverview on the injected gateway client.
  const bff = new BffOverview(api as Client<typeof ui.GatewayService>);
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = bff.subscribe([], firstAbort.signal)[Symbol.asyncIterator]();
  const second = bff.subscribe([], secondAbort.signal)[Symbol.asyncIterator]();

  try {
    const [firstSnapshot, secondSnapshot] = await Promise.all([first.next(), second.next()]);
    expect(firstSnapshot.value?.change.case).toBe("mobileSnapshot");
    expect(secondSnapshot.value?.change.case).toBe("mobileSnapshot");
    expect((await first.next()).value?.change.case).toBe("feeds");
    expect((await second.next()).value?.change.case).toBe("feeds");
    expect(watchCalls).toBe(1);

    const [overview, settings] = await Promise.all([bff.overview(), bff.settings()]);
    expect(overview.workers.map((worker) => worker.id)).toContain(gateway.workerId);

    const changed = await gateway.api.updateUserSettings({
      expectedVersion: settings.user?.version ?? 0n,
      timezone: "Europe/Warsaw",
    });

    const currentSettings = await eventually(
      () => bff.settings(),
      (current) => current.user?.version === changed.settings?.version,
    );

    expect(currentSettings.user).toMatchObject({ version: changed.settings!.version, timezone: "Europe/Warsaw" });
    const project = (await gateway.api.createProject({ name: "BFF materialized project" })).project!;

    const workspace = (
      await gateway.api.createWorkspace({ projectId: project.id, workerId: gateway.workerId, rootPath: "/repo/bff" })
    ).workspace!;

    const thread = (
      await gateway.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX })
    ).thread!;

    await gateway.api.updateThread({ threadId: thread.id, title: "Live title" });
    expect(
      (
        await eventually(
          () => bff.thread(thread.id),
          (current) => current?.title === "Live title",
        )
      )?.title,
    ).toBe("Live title");

    const currentOverview = await eventually(
      () => bff.overview(),
      (current) => current.projects.some((candidate) => candidate.id === project.id),
    );

    expect(currentOverview.projects.map((candidate) => candidate.id)).toContain(project.id);
    expect((await bff.threads()).threads.map((candidate) => candidate.id)).toContain(thread.id);
    expect((await bff.threads(project.id)).threads.map((candidate) => candidate.id)).toEqual([thread.id]);
  } finally {
    firstAbort.abort();
    secondAbort.abort();
    await first.return?.();
    await second.return?.();
    bff.close();
  }
});

test.skipIf(!dockerAvailable)("reconnect reads fresh gateway state and close fences a delayed old stream", async () => {
  const gw = await startTestGateway();
  gateway = gw;
  const project = (await gw.api.createProject({ name: "Reconnect" })).project!;

  const workspace = (
    await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo/reconnect" })
  ).workspace!;

  const first = (
    await gw.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX })
  ).thread!;

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const lateEntered = Promise.withResolvers<void>();
  const lateRelease = Promise.withResolvers<void>();
  const lateFinished = Promise.withResolvers<void>();
  let attempts = 0;
  let failNext = false;
  let holdLate = false;

  async function* watchOverview(...args: Parameters<Client<typeof ui.GatewayService>["watchOverview"]>) {
    const attempt = ++attempts;

    if (attempt === 3) {
      entered.resolve();
      await release.promise;
    }

    for await (const update of gw.api.watchOverview(...args)) {
      if (attempt === 1 || failNext) {
        failNext = false;
        throw new ConnectError("Stream interrupted", Code.Unavailable);
      }

      if (holdLate && update.change.case === "thread" && update.change.value.title === "Delayed update") {
        lateEntered.resolve();
        await lateRelease.promise;

        try {
          yield update;
        } finally {
          lateFinished.resolve();
        }
      } else yield update;
    }
  }

  const bff = new BffOverview({ ...gw.api, watchOverview });
  const observed: ui.OverviewUpdate[] = [];
  bff.listen((update) => observed.push(update));

  try {
    expect((await bff.thread(first.id))?.id).toBe(first.id);
    expect(attempts).toBe(2);
    failNext = true;
    await gw.api.updateThread({ threadId: first.id, title: "Drop the stream" });
    await entered.promise;
    let answered = false;

    const pending = bff.threads().then((value) => {
      answered = true;

      return value;
    });

    await gw.api.deleteThread({ threadId: first.id });

    const second = (
      await gw.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX })
    ).thread!;

    const settings = await gw.api.getSettings({});
    await gw.api.updateUserSettings({ expectedVersion: settings.user?.version ?? 0n, timezone: "Asia/Tokyo" });
    expect(answered).toBe(false);
    release.resolve();
    expect((await pending).threads.map((thread) => thread.id)).toEqual([second.id]);
    expect(await bff.thread(first.id)).toBeUndefined();
    expect((await bff.settings()).user?.timezone).toBe("Asia/Tokyo");
    expect(bff.revision).toBe(2);
    holdLate = true;
    await gw.api.updateThread({ threadId: second.id, title: "Delayed update" });
    await lateEntered.promise;
    bff.close();
    lateRelease.resolve();
    await lateFinished.promise;
    expect(
      observed.some((update) => update.change.case === "thread" && update.change.value.title === "Delayed update"),
    ).toBe(false);
    expect(
      await bff.thread(second.id).then(
        () => false,
        () => true,
      ),
    ).toBe(true);
  } finally {
    bff.close();
    release.resolve();
    lateRelease.resolve();
  }
});

test.skipIf(!dockerAvailable)("authenticated linked snapshots prune revoked rows and shared workspaces", async () => {
  const gw = await startTestGateway();
  gateway = gw;
  const project = (await gw.api.createProject({ name: "Local project" })).project!;

  const workspace = (
    await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo/privacy" })
  ).workspace!;

  const bff = new BffOverview(gw.api);
  const nodeId = "a".repeat(64);
  const remoteWorker = qualifyId(crypto.randomUUID(), nodeId);
  const remoteProject = qualifyId(crypto.randomUUID(), nodeId);
  const remoteThread = qualifyId(crypto.randomUUID(), nodeId);
  const remoteWorkspace = qualifyId(crypto.randomUUID(), nodeId);

  const snapshot = create(ui.OverviewUpdateSchema, {
    change: {
      case: "computerSnapshot",
      value: {
        nodeId,
        overview: {
          workers: [{ id: remoteWorker, nodeId, name: "Linked worker" }],
          projects: [
            {
              id: project.id,
              name: project.name,
              workspaces: [{ id: remoteWorkspace, projectId: project.id, workerId: remoteWorker }],
            },
            { id: remoteProject, nodeId, name: "Private linked project" },
          ],
        },
        threads: [{ id: remoteThread, projectId: remoteProject, nodeId, title: "Private linked thread" }],
      },
    },
  });

  const publish = () => {
    gw.core.hub.publishOverview(
      create(ui.OverviewUpdateSchema, {
        change: { case: "computer", value: { nodeId, name: "Linked computer", status: "connected" } },
      }),
    );
    gw.core.hub.publishOverview(snapshot);
  };

  try {
    await bff.overview();
    publish();
    expect((await eventually(() => bff.thread(remoteThread), Boolean))?.id).toBe(remoteThread);
    expect(
      (await bff.overview()).projects.find((row) => row.id === project.id)?.workspaces.map((row) => row.id),
    ).toEqual([workspace.id, remoteWorkspace]);
    gw.core.hub.publishOverview(
      create(ui.OverviewUpdateSchema, {
        change: { case: "computerSnapshot", value: { nodeId, overview: {}, threads: [] } },
      }),
    );
    expect(
      await eventually(
        () => bff.thread(remoteThread),
        (row) => !row,
      ),
    ).toBeUndefined();
    expect((await bff.overview()).workers.some((row) => row.id === remoteWorker)).toBe(false);
    expect((await bff.overview()).projects.some((row) => row.id === remoteProject)).toBe(false);
    expect(
      (await bff.overview()).projects.find((row) => row.id === project.id)?.workspaces.map((row) => row.id),
    ).toEqual([workspace.id]);
    publish();
    await eventually(() => bff.thread(remoteThread), Boolean);
    gw.core.hub.publishOverview(
      create(ui.OverviewUpdateSchema, { change: { case: "computerRemoved", value: nodeId } }),
    );
    expect(
      await eventually(
        () => bff.thread(remoteThread),
        (row) => !row,
      ),
    ).toBeUndefined();
    expect((await bff.overview()).computers.some((row) => row.nodeId === nodeId)).toBe(false);
  } finally {
    bff.close();
  }
});

test.skipIf(!dockerAvailable)(
  "head unions reopen only a bounded head stream, never WatchOverview",
  async () => {
    const gw = await startTestGateway();
    gateway = gw;
    const overviewRequests: string[][] = [];
    const headRequests: string[][] = [];

    async function* watchOverview(...args: Parameters<Client<typeof ui.GatewayService>["watchOverview"]>) {
      overviewRequests.push([...(args[0].threadHeadIds ?? [])]);
      yield* gw.api.watchOverview(...args);
    }

    function watchThreadHeads(...args: Parameters<Client<typeof ui.GatewayService>["watchThreadHeads"]>) {
      headRequests.push([...(args[0].threadIds ?? [])]);

      return gw.api.watchThreadHeads(...args);
    }

    const bff = new BffOverview({ ...gw.api, watchOverview, watchThreadHeads });
    const abort = new AbortController();
    const firstHeads = Array.from({ length: 32 }, () => crypto.randomUUID()).sort();
    const secondHeads = Array.from({ length: 32 }, () => crypto.randomUUID());

    try {
      const first = bff.subscribe(firstHeads, abort.signal)[Symbol.asyncIterator]();
      expect((await first.next()).value?.change.case).toBe("mobileSnapshot");
      const second = bff.subscribe(secondHeads, abort.signal)[Symbol.asyncIterator]();
      expect((await second.next()).value?.change.case).toBe("mobileSnapshot");
      const third = bff.subscribe(firstHeads, abort.signal)[Symbol.asyncIterator]();
      expect((await third.next()).value?.change.case).toBe("mobileSnapshot");
      const project = (await gw.api.createProject({ name: "Union settled" })).project!;
      await eventually(
        () => bff.overview(),
        (current) => current.projects.some((row) => row.id === project.id),
      );
      expect(overviewRequests).toEqual([[]]);
      expect(headRequests).toHaveLength(2);
      expect(headRequests.every((heads) => heads.length === 32)).toBe(true);
      await third.return?.();
      await gw.api.renameProject({ projectId: project.id, name: "Same union" });
      await eventually(
        () => bff.overview(),
        (current) => current.projects.some((row) => row.name === "Same union"),
      );
      expect(headRequests).toHaveLength(2);
      await second.return?.();
      await eventually(
        async () => headRequests.length,
        (count) => count === 3,
      );
      expect(headRequests.at(-1)).toEqual(firstHeads);
      expect(overviewRequests).toEqual([[]]);
      expect(bff.revision).toBe(0);
    } finally {
      abort.abort();
      bff.close();
    }
  },
  20_000,
);
