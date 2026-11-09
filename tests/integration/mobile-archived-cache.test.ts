import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { ArchivedThreadsPager, type ArchivedPageState } from "@canopy/domain/archived-threads";
import { tempDirs } from "@canopy/testing";
import { PersistentArchivedCache } from "../../apps/mobile/src/storage/archived-cache.ts";
import { clearPairedHistory } from "../../apps/mobile/src/storage/bot-cache.ts";
import { DiskThreadStorage } from "./support/thread-cache.ts";

const directory = tempDirs();
const filter = { projectIds: [], query: "" };

const thread = (id: string, nodeId = "", at = 1000) =>
  create(ui.ThreadSchema, {
    id,
    title: `Saved ${id}`,
    projectId: "project",
    workerId: "worker",
    nodeId,
    status: "archived",
    archivedAt: timestampFromMs(at),
  });

const state = (threads: ui.Thread[], nextPageToken = ""): ArchivedPageState => ({
  threads,
  sideThreads: [],
  totalCount: threads.length,
  nextPageToken,
  loaded: true,
  loading: false,
  error: "",
});

describe("persistent mobile archived sidebar", () => {
  test("restart restores local and linked rows, metadata, filter scope and cached pagination before a slow refresh", async () => {
    const storage = new DiskThreadStorage(directory("canopy-archived-pages-"));
    const cache = new PersistentArchivedCache(storage);

    const rows = Array.from({ length: 40 }, (_, index) =>
      thread(String(index), index % 2 ? "peer" : "", 10000 - index),
    );

    const saved = state(rows, "older");
    saved.totalCount = 60;

    await cache.rememberMetadata(
      [create(ui.ProjectSchema, { id: "project", name: "Canopy" })],
      [create(ui.WorkerSchema, { id: "worker", name: "Computer" })],
    );
    await cache.remember(filter, saved);
    const restarted = new PersistentArchivedCache(storage);
    await restarted.restore();
    expect(restarted.peek(filter)).toEqual(saved);
    expect(restarted.metadata.workers[0]?.name).toBe("Computer");
    expect(restarted.peek({ projectIds: ["other"], query: "" })?.threads).toEqual([]);
    expect(restarted.peek({ projectIds: ["project"], query: "CANOPY" })?.threads).toHaveLength(40);
    const response = Promise.withResolvers<ui.ListArchivedThreadsResponse>();

    const pager = new ArchivedThreadsPager(
      () => response.promise,
      () => {},
      (filter) => restarted.peek(filter),
    );

    const refreshing = pager.refresh(filter, true, "online");
    expect(pager.state.threads).toEqual(rows);
    expect(pager.state.loading).toBe(true);
    response.reject(new Error("Offline"));
    await refreshing;
    expect(pager.state.threads).toEqual(rows);
    expect(pager.state.error).toBe("Offline");
    pager.dispose();
  });

  test("explicit archive, rename, unarchive, delete and unlink merge durably without dropping offline peers", async () => {
    const storage = new DiskThreadStorage(directory("canopy-archived-merge-"));
    const cache = new PersistentArchivedCache(storage);
    const old = thread("old");
    const peer = thread("peer", "peer", 900);
    await cache.remember(filter, state([old, peer]));
    await cache.reconcile(thread("new", "", 2000));
    await cache.reconcile({ ...old, title: "Renamed" });
    expect(cache.peek(filter)?.threads.map((row) => row.id)).toEqual(["new", "old", "peer"]);
    expect(cache.peek(filter)?.threads[1]?.title).toBe("Renamed");
    await cache.reconcile({ ...old, status: "idle", archivedAt: undefined });
    await cache.reconcile({ ...thread("new"), deletedAt: timestampFromMs(3000) });
    const restarted = new PersistentArchivedCache(storage);
    await restarted.restore();
    expect(restarted.peek(filter)?.threads).toEqual([peer]);

    const refreshed = restarted.withSavedPeers(
      { ...filter, pageToken: "", countOnly: false },
      create(ui.ListArchivedThreadsResponseSchema, { threads: [thread("local", "", 2000)], totalCount: 1 }),
    );

    expect(refreshed.threads.map((row) => row.id)).toEqual(["local", "peer"]);
    expect(refreshed.totalCount).toBe(2);
    await restarted.forgetComputer("peer");
    expect(restarted.peek(filter)?.threads).toEqual([]);
  });

  test("an archive event is durable even before the first archive page was fetched", async () => {
    const storage = new DiskThreadStorage(directory("canopy-archived-event-"));
    const cache = new PersistentArchivedCache(storage);
    await cache.reconcile(thread("first"));
    await cache.reconcile(thread("peer", "peer"));
    await cache.forgetComputer("peer");
    const restarted = new PersistentArchivedCache(storage);
    await restarted.restore();
    expect(restarted.peek(filter)?.threads).toEqual([thread("first")]);
    expect(restarted.peek(filter)?.loaded).toBe(false);
    expect(restarted.peek(filter)?.totalCount).toBeUndefined();
  });

  test("older saved peer rows stay in cursor order as local pages arrive", async () => {
    const cache = new PersistentArchivedCache(new DiskThreadStorage(directory("canopy-archived-peer-pages-")));
    const peer = thread("peer", "peer", 1000);
    await cache.remember(filter, state([peer]));

    const pager = new ArchivedThreadsPager(
      async (request) =>
        cache.withSavedPeers(
          request,
          create(ui.ListArchivedThreadsResponseSchema, {
            threads: [thread(request.pageToken ? "middle" : "newest", "", request.pageToken ? 2000 : 3000)],
            totalCount: 2,
            nextPageToken: request.pageToken ? "" : "older",
          }),
        ),
      () => {},
      (filter) => cache.peek(filter),
      (filter, state) => {
        void cache.remember(filter, state);
      },
    );

    await pager.refresh(filter, true);
    expect(cache.peek(filter)?.threads.map((row) => row.id)).toEqual(["newest", "peer"]);
    await pager.more();
    expect(cache.peek(filter)?.threads.map((row) => row.id)).toEqual(["newest", "middle", "peer"]);
    expect(cache.peek(filter)?.totalCount).toBe(3);
    pager.dispose();
  });

  test("cached pages stay visible through refresh, pagination and a filter change", async () => {
    const cache = new PersistentArchivedCache(new DiskThreadStorage(directory("canopy-archived-pagination-")));
    const rows = Array.from({ length: 40 }, (_, index) => thread(String(index)));
    await cache.remember(filter, state(rows, "old-cursor"));
    let requested = 0;

    const pager = new ArchivedThreadsPager(
      async (request) => {
        requested++;

        if (request.countOnly) return create(ui.ListArchivedThreadsResponseSchema, { totalCount: 45 });

        switch (request.pageToken) {
          case "fresh-cursor":
            return create(ui.ListArchivedThreadsResponseSchema, {
              threads: rows.slice(20),
              nextPageToken: "last-cursor",
              totalCount: 45,
            });
          case "last-cursor":
            return create(ui.ListArchivedThreadsResponseSchema, { threads: [thread("older")], totalCount: 45 });
          default:
            return create(ui.ListArchivedThreadsResponseSchema, {
              threads: rows.slice(0, 20),
              nextPageToken: "fresh-cursor",
              totalCount: 45,
            });
        }
      },
      () => {},
      (filter) => cache.peek(filter),
      (filter, state) => {
        void cache.remember(filter, state);
      },
      () => cache.revision,
    );

    const refreshing = pager.refresh(filter, true, "first");
    expect(pager.state.threads).toEqual(rows);
    await refreshing;
    expect(pager.state.threads).toEqual(rows);
    await pager.refresh(filter, false, "first");
    expect(pager.state.threads).toEqual(rows);
    await pager.refresh(filter, true, "first");
    await cache.reconcile({ ...rows[0]!, status: "idle" });
    await pager.more();
    expect(pager.state.threads.some((row) => row.id === "0")).toBe(false);
    expect(pager.state.threads.at(-1)?.id).toBe("older");
    const before = requested;
    await pager.refresh({ projectIds: [], query: "Saved" }, true, "first");
    expect(requested).toBeGreaterThan(before);
    pager.dispose();
  });

  test("lifecycle events received during a fetch win over its response", async () => {
    const cache = new PersistentArchivedCache(new DiskThreadStorage(directory("canopy-archived-race-")));
    const old = thread("old");
    await cache.remember(filter, state([old]));
    const response = Promise.withResolvers<ui.ListArchivedThreadsResponse>();
    const request = { ...filter, pageToken: "", countOnly: false };

    const pager = new ArchivedThreadsPager(
      () => response.promise,
      () => {},
      (filter) => cache.peek(filter),
      (filter, state) => {
        void cache.remember(filter, state);
      },
      () => cache.revision,
    );

    const fetching = pager.refresh(request, true, "first");
    await cache.reconcile({ ...old, status: "idle" });
    await cache.reconcile(thread("new", "peer", 2000));
    response.resolve(create(ui.ListArchivedThreadsResponseSchema, { threads: [old], totalCount: 1 }));
    await fetching;
    expect(cache.peek(filter)?.threads.map((row) => row.id)).toEqual(["new"]);
    pager.dispose();
  });

  test("unpair fences pending writes and late callbacks, and a different pairing never reads saved rows", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    class SlowStorage extends DiskThreadStorage {
      override async write(id: string, bytes: Uint8Array) {
        entered.resolve();
        await release.promise;
        await super.write(id, bytes);
      }
    }

    const root = directory("canopy-archived-pairing-");
    const storage = new SlowStorage(`${root}/device-one-certificate-one`);
    const cache = new PersistentArchivedCache(storage);
    const writing = cache.remember(filter, state([thread("private")]));
    await entered.promise;
    const clearing = clearPairedHistory([cache], () => Promise.resolve());
    expect(cache.peek(filter)).toBeUndefined();
    release.resolve();
    await writing;
    expect(await clearing).toBe(true);
    await cache.remember(filter, state([thread("late")]));
    await cache.reconcile(thread("later"));
    expect(await storage.list()).toEqual([]);
    const other = new PersistentArchivedCache(new DiskThreadStorage(`${root}/device-two-certificate-two`));
    await other.restore();
    expect(other.peek(filter)).toBeUndefined();
  });

  test("corrupt entries fall back to a cold cache and filter retention stays bounded", async () => {
    const storage = new DiskThreadStorage(directory("canopy-archived-bounds-"));
    await storage.write("broken", new Uint8Array([255]));
    const cache = new PersistentArchivedCache(storage);
    await cache.restore();
    expect(cache.peek(filter)).toBeUndefined();

    for (let index = 0; index < 12; index++)
      await cache.remember({ projectIds: [], query: String(index) }, state([thread(String(index))]));
    expect((await storage.list()).length).toBeLessThanOrEqual(8);
  });
});
