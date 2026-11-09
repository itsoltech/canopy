import { describe, expect, test } from "bun:test";
import { QueryCache, QueryCacheDisposed } from "./shared-query.ts";

/** A fetch whose calls are counted and answered by the test. */
function controlled<T>() {
  const calls: { resolve: (value: T) => void; reject: (cause: Error) => void; signal: AbortSignal }[] = [];

  const fetch = (signal: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      calls.push({ resolve, reject, signal });
    });

  return { fetch, calls };
}

const settle = () => Bun.sleep(5);

describe("shared session reads", () => {
  test("consumers of one key share one request and an empty result counts as loaded", async () => {
    const cache = new QueryCache({ coalesceMs: 0 });
    const reader = controlled<string[]>();
    const changes: number[] = [];
    const stop = [1, 2, 3].map((n) => cache.watch("ListProxies", reader.fetch, () => changes.push(n)));
    const read = cache.read("ListProxies", reader.fetch);

    expect(reader.calls).toHaveLength(1);
    reader.calls[0]!.resolve([]);
    expect(await read).toEqual([]);
    expect(cache.snapshot("ListProxies")).toMatchObject({ data: [], loaded: true, loading: false });
    await cache.read("ListProxies", reader.fetch);
    stop.forEach((unsubscribe) => unsubscribe());
    cache.watch("ListProxies", reader.fetch, () => {});
    expect(reader.calls).toHaveLength(1);
  });

  test("a burst of invalidations reads once, and once more if it arrives during the read", async () => {
    const cache = new QueryCache({ coalesceMs: 10 });
    const reader = controlled<number>();
    cache.watch("ListWorkerRecords", reader.fetch, () => {});
    reader.calls[0]!.resolve(1);
    await settle();

    for (let n = 0; n < 8; n++) cache.invalidate("ListWorkerRecords");
    expect(cache.snapshot("ListWorkerRecords").stale).toBe(true);
    await Bun.sleep(20);
    expect(reader.calls).toHaveLength(2);

    for (let n = 0; n < 8; n++) cache.invalidate("ListWorkerRecords");
    await Bun.sleep(20);
    expect(reader.calls).toHaveLength(2);
    reader.calls[1]!.resolve(2);
    await settle();
    expect(reader.calls).toHaveLength(3);
    reader.calls[2]!.resolve(3);
    await settle();
    expect(cache.snapshot("ListWorkerRecords")).toMatchObject({ data: 3, stale: false, loading: false });
    expect(reader.calls).toHaveLength(3);
  });

  test("an unwatched key is only marked stale and reads on its next use", async () => {
    const cache = new QueryCache({ coalesceMs: 0 });
    const reader = controlled<number>();
    const read = cache.read("GetAgentEnvironment", reader.fetch);
    reader.calls[0]!.resolve(1);
    await read;
    cache.invalidate((key) => key.startsWith("GetAgent"));
    await settle();
    expect(reader.calls).toHaveLength(1);
    const again = cache.read("GetAgentEnvironment", reader.fetch);
    reader.calls[1]!.resolve(2);
    expect(await again).toBe(2);
  });

  test("a read started before a set value is older and does not overwrite it", async () => {
    const cache = new QueryCache({ coalesceMs: 0 });
    const reader = controlled<string>();
    cache.watch("GetSettings", reader.fetch, () => {});
    cache.set("GetSettings", "from mutation");
    reader.calls[0]!.resolve("older read");
    await settle();
    expect(cache.snapshot("GetSettings")).toMatchObject({ data: "from mutation", loaded: true, loading: false });
    cache.set<string>("GetSettings", (current) => `${current}, updated`);
    expect(cache.snapshot<string>("GetSettings").data).toBe("from mutation, updated");
  });

  test("a failed read keeps the last value and reports the error", async () => {
    const cache = new QueryCache({ coalesceMs: 0, failure: () => "Could not load proxies." });
    const reader = controlled<string>();
    cache.watch("ListProxies", reader.fetch, () => {});
    reader.calls[0]!.resolve("first");
    await settle();
    cache.invalidate("ListProxies");
    await settle();
    reader.calls[1]!.reject(new Error("unavailable"));
    await settle();
    expect(cache.snapshot("ListProxies")).toMatchObject({
      data: "first",
      loaded: true,
      error: "Could not load proxies.",
    });
  });

  test("forget and dispose fence reads in flight", async () => {
    const cache = new QueryCache({ coalesceMs: 0 });
    const reader = controlled<string>();
    const read = cache.read("ListModels:node-b", reader.fetch);
    cache.forget((key) => key.endsWith(":node-b"));
    expect(reader.calls[0]!.signal.aborted).toBe(true);
    reader.calls[0]!.resolve("unlinked home");
    expect(read).rejects.toBeInstanceOf(QueryCacheDisposed);
    expect(cache.snapshot("ListModels:node-b").loaded).toBe(false);

    const watched = controlled<string>();
    cache.watch("ListBots", watched.fetch, () => {});
    cache.dispose();
    watched.calls[0]!.resolve("previous owner");
    await settle();
    expect(cache.snapshot("ListBots").data).toBeUndefined();
    expect(cache.read("ListBots", watched.fetch)).rejects.toBeInstanceOf(QueryCacheDisposed);
    expect(watched.calls).toHaveLength(1);
  });

  test("a forgotten watched key reads again for its consumers", async () => {
    const cache = new QueryCache({ coalesceMs: 0 });
    const reader = controlled<string>();
    const seen: (string | undefined)[] = [];
    cache.watch("GetComputers", reader.fetch, () => seen.push(cache.snapshot<string>("GetComputers").data));
    reader.calls[0]!.resolve("linked");
    await settle();
    cache.forget("GetComputers");
    expect(reader.calls).toHaveLength(2);
    reader.calls[1]!.resolve("after unlink");
    await settle();
    expect(cache.snapshot("GetComputers").data).toBe("after unlink");
    expect(seen).toContain(undefined);
  });

  test("a new watcher reads a value older than its bound again; a current one is shared", async () => {
    const cache = new QueryCache({ coalesceMs: 0 });
    let reads = 0;
    const fetch = async () => ++reads;
    cache.watch("GetComputers", fetch, () => {}, 50)();
    await settle();
    cache.watch("GetComputers", fetch, () => {}, 50)();
    await settle();
    expect(reads).toBe(1);
    await Bun.sleep(60);
    cache.watch("GetComputers", fetch, () => {}, 50)();
    await settle();
    expect(reads).toBe(2);
  });

  test("unwatched entries stay within the LRU bound", async () => {
    const cache = new QueryCache({ idle: 2, coalesceMs: 0 });

    for (const key of ["a", "b", "c", "d"]) await cache.read(key, async () => key);
    const watched = controlled<string>();
    cache.watch("e", watched.fetch, () => {});
    watched.calls[0]!.resolve("e");
    await settle();
    expect(["a", "b", "c", "d"].filter((key) => cache.snapshot(key).loaded)).toEqual(["c", "d"]);
    expect(cache.snapshot("e").loaded).toBe(true);
  });
});
