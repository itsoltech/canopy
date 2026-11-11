import { expect, test } from "bun:test";
import { ui } from "@canopy/contracts";
import { databaseMetric } from "@canopy/domain/diagnostics";
import { RpcCollector } from "../src/diagnostics/collector.ts";
import { registered } from "../src/diagnostics/registry.ts";
import { rpcSnapshot } from "../src/diagnostics/snapshot.ts";

test("deferred SQL timings preserve minute boundaries, RPC correlation and errors in rollups", () => {
  const method = registered(ui.GatewayService.method.getThread);
  let now = 0;
  const collector = new RpcCollector([method], { monotonic: () => now, utc: () => now });
  const id = databaseMetric("thread.read", "execute");
  collector.recordDatabase(id, 12, false, method.id, 59_990);
  collector.recordDatabase(id, 34, true, method.id, 60_010);
  now = 65_000;
  collector.tick();

  for (const [at, error, duration] of [
    [0, 0n, 12],
    [60_000, 1n, 34],
  ] as const) {
    const rollup = collector.rollup(at)!;

    for (const rpc of [0, method.id]) {
      const value = rollup.measures.find((row) => row.metricId === id && row.rpcMethodId === rpc);
      expect(value?.events).toBe(1n);
      expect(value?.errors).toBe(error);
      expect(value?.histogram?.max).toBe(duration);
    }

    expect(rollup.measures.find((row) => row.metricId === 11)?.events).toBe(1n);
  }

  expect(collector.budget.dropped).toBe(0);
});

test("an overloaded SQL sample buffer drops explicitly and marks affected distributions incomplete", () => {
  const collector = new RpcCollector([], { monotonic: () => 0, utc: () => 0 });
  const id = databaseMetric("thread.read", "execute");

  for (let count = 0; count < 1500; count++) collector.recordDatabase(id, 12, true, 0, 0);
  const value = rpcSnapshot(collector, 15);
  const family = value.database.find((row) => row.family === "thread.read");
  expect(family?.executeErrors).toBe(1024n);
  expect(family?.executeMs?.samples).toBe(1024n);
  expect(family?.incomplete).toBe(true);
  expect(collector.budget.dropped).toBe(476);
  expect(collector.budget.used).toBeLessThan(64 * 1024);
  collector.recordDatabase(id, 15, false, 0, 0);
  expect(collector.rollup(0)?.measures.find((row) => row.metricId === id)?.events).toBe(1025n);
});
