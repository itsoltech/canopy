import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { QueryCache } from "./shared-query.ts";
import { OverviewInvalidation } from "./shared-query-events.ts";

const update = (change: ui.OverviewUpdate["change"]) => create(ui.OverviewUpdateSchema, { change });
const worker = (id: string, appliedVersion = 1n) => create(ui.WorkerSchema, { id, online: true, appliedVersion });

/** A cache whose watched keys count their reads. */
async function watched(keys: string[]) {
  const queries = new QueryCache({ coalesceMs: 5 });
  const reads = new Map<string, number>();

  for (const key of keys)
    queries.watch(
      key,
      async () => reads.set(key, (reads.get(key) ?? 0) + 1),
      () => {},
    );

  await Bun.sleep(10);
  reads.clear();

  return { queries, reads, invalidation: new OverviewInvalidation(queries) };
}

describe("overview events and shared reads", () => {
  test("mirror commits and last-seen heartbeats do not reload computer settings; changes and reconnect do", async () => {
    const { queries, reads, invalidation } = await watched(["GetComputers", "ListWorkerRecords"]);
    const computer = create(ui.LinkedComputerSchema, { nodeId: "home", name: "Computer B", status: "connected" });
    invalidation.apply(update({ case: "computer", value: computer }));
    await Bun.sleep(20);
    reads.clear();

    for (let n = 0; n < 100; n++)
      invalidation.apply(update({ case: "computer", value: { ...computer, lastSeenMs: BigInt(n) } }));
    await Bun.sleep(20);
    expect(reads.size).toBe(0);

    invalidation.apply(update({ case: "computer", value: { ...computer, shareConfig: true } }));
    await Bun.sleep(20);
    expect(Object.fromEntries(reads)).toEqual({ GetComputers: 1, ListWorkerRecords: 1 });
    reads.clear();
    invalidation.apply(update({ case: "sharedConfig", value: create(ui.SharedConfigSnapshotSchema) }));
    await Bun.sleep(20);
    expect(Object.fromEntries(reads)).toEqual({ GetComputers: 1 });
    invalidation.synced([], true);
    await Bun.sleep(20);
    expect(reads.get("GetComputers")).toBe(2);
    queries.dispose();
  });
  test.each(["thread", "gap"])("%s revalidation retains mounted PR consumers through a delayed read", async (event) => {
    const queries = new QueryCache({ coalesceMs: 0 });
    const invalidation = new OverviewInvalidation(queries);
    const key = "GetPullRequest:pr";
    const initial = { title: "First summary" };
    const refreshed = { title: "Updated summary" };
    const pending = Promise.withResolvers<typeof initial>();
    const seen: (typeof initial | undefined)[] = [];
    let reads = 0;
    queries.set(key, initial);

    const stops = [1, 2].map(() =>
      queries.watch(
        key,
        () => {
          reads++;

          return pending.promise;
        },
        () => seen.push(queries.snapshot<typeof initial>(key).data),
      ),
    );

    try {
      if (event === "gap") invalidation.synced([], true);
      else
        invalidation.apply(
          update({ case: "thread", value: create(ui.ThreadSchema, { id: "thread", pullRequestRevision: 1n }) }),
        );
      await Bun.sleep(10);
      expect(reads).toBe(1);
      expect(queries.snapshot(key)).toMatchObject({ data: initial, loaded: true, loading: true });
      expect(queries.snapshot("GetPullRequest:another-pr").loaded).toBe(false);
      pending.resolve(refreshed);
      await Bun.sleep(10);
      expect(queries.snapshot(key)).toMatchObject({ data: refreshed, loaded: true, loading: false });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((value) => value === initial || value === refreshed)).toBe(true);
    } finally {
      stops.forEach((stop) => stop());
      queries.dispose();
    }
  });

  test("a failed PR revalidation keeps content and unchanged thread revisions do not retry it", async () => {
    const queries = new QueryCache({ coalesceMs: 0 });
    const invalidation = new OverviewInvalidation(queries);
    const key = "GetPullRequest:pr";
    const initial = { title: "Cached summary" };

    const thread = update({
      case: "thread",
      value: create(ui.ThreadSchema, { id: "thread", pullRequestRevision: 2n }),
    });

    let reads = 0;
    queries.set(key, initial);

    const stop = queries.watch(
      key,
      async () => {
        reads++;
        throw new Error("Offline");
      },
      () => {},
    );

    try {
      invalidation.apply(thread);
      await Bun.sleep(10);
      expect(queries.snapshot(key)).toMatchObject({ data: initial, loaded: true, loading: false, error: "Offline" });
      invalidation.apply(thread);
      await Bun.sleep(10);
      expect(reads).toBe(1);
    } finally {
      stop();
      queries.dispose();
    }
  });

  test("a home resnapshot drops private PR content and a late pre-revoke response cannot restore it", async () => {
    const queries = new QueryCache();
    const pending = Promise.withResolvers<string | null>();
    const key = "GetPullRequest:pr~home";
    let reads = 0;

    const stop = queries.watch(
      key,
      () => (++reads === 1 ? pending.promise : Promise.resolve(null)),
      () => {},
    );

    queries.set(key, "private summary before revoke");
    new OverviewInvalidation(queries).apply(
      update({ case: "computerSnapshot", value: create(ui.LinkedComputerSnapshotSchema, { nodeId: "home" }) }),
    );
    expect(queries.snapshot(key).data).toBeUndefined();
    pending.resolve("late private summary");
    await Bun.sleep(20);
    expect(queries.snapshot(key).data).toBeNull();
    stop();
    queries.dispose();
  });
  test("a broadcast repeating every worker unchanged reads nothing; a changed report reads the library once", async () => {
    const { reads, invalidation } = await watched(["GetAgentEnvironment", "ListWorkerRecords"]);
    const workers = Array.from({ length: 8 }, (_, n) => worker(`w${n}`));
    invalidation.synced(workers, false);

    for (const value of workers) invalidation.apply(update({ case: "worker", value }));
    await Bun.sleep(20);
    expect(reads.size).toBe(0);

    for (const value of workers) invalidation.apply(update({ case: "worker", value: worker(value.id, 2n) }));
    await Bun.sleep(20);
    expect(Object.fromEntries(reads)).toEqual({ GetAgentEnvironment: 1 });
  });

  test("named changes reach their reads, including joined and scoped keys", async () => {
    const { reads, invalidation } = await watched([
      "ListWorkerRecords",
      "ListProxies+ListWorkerRecords",
      "ListModels:all",
      "GetComputers",
      "ListConnectors",
    ]);

    invalidation.apply(update({ case: "workerRecordsChanged", value: true }));
    invalidation.apply(update({ case: "linkedReadCompleted", value: "ListModels" }));
    await Bun.sleep(20);
    expect(Object.fromEntries(reads)).toEqual({
      ListWorkerRecords: 1,
      "ListProxies+ListWorkerRecords": 1,
      "ListModels:all": 1,
    });
  });

  test("a gap in the stream makes every read stale once; the first snapshot does not", async () => {
    const { reads, invalidation } = await watched(["GetComputers", "ListConnectors"]);
    invalidation.synced([], false);
    await Bun.sleep(20);
    expect(reads.size).toBe(0);
    invalidation.synced([], true);
    await Bun.sleep(20);
    expect(Object.fromEntries(reads)).toEqual({ GetComputers: 1, ListConnectors: 1 });
  });
});
