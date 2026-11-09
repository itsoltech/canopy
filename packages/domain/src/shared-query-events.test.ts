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
