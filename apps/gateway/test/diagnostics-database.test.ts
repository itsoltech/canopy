import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { databaseMetric, DATABASE_FAMILIES, DATABASE_PHASES, Measure } from "@canopy/domain/diagnostics";
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

test("family and RPC churn stays inside the internal measure sub-budget and releases expired storage", () => {
  const method = registered(ui.GatewayService.method.getThread);
  let now = 0;
  const collector = new RpcCollector([method], { monotonic: () => now, utc: () => now });

  for (let minute = 0; minute < 90; minute++) {
    now = minute * 60_000;

    for (const family of DATABASE_FAMILIES)
      for (const phase of DATABASE_PHASES)
        collector.recordDatabase(databaseMetric(family.name, phase), minute + 1, true, method.id, now);
    collector.tick();
    expect(collector.measureBudget.used).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(collector.databaseBudget.used).toBeLessThanOrEqual(3 * 1024 * 1024);
    expect(collector.budget.used).toBeLessThanOrEqual(collector.budget.limit);
  }

  expect(collector.budget.dropped).toBeGreaterThan(0);
  now += 3_660_000;
  collector.short.expire(now);
  collector.minutes.expire(now);
  collector.historyMinutes.expire(now);
  expect(collector.measureBudget.used).toBe(0);
  expect(collector.databaseBudget.used).toBe(0);
  collector.recordDatabase(databaseMetric("thread.read", "execute"), 12, false, method.id, now);
  expect(collector.rollup(now)?.measures.some((row) => row.metricId === 11)).toBe(true);
});

test("restored SQL history leaves room for fresh process and query measurements", () => {
  const now = 3_600_000;
  const collector = new RpcCollector([], { monotonic: () => now, utc: () => now });
  const timing = new Measure();
  timing.timing(12, false, 0);

  const history = create(ui.DiagnosticsProcessSchema, {
    measures: DATABASE_FAMILIES.flatMap((family) =>
      DATABASE_PHASES.map((phase) => timing.snapshot(databaseMetric(family.name, phase))),
    ),
  });

  for (let minute = 60; minute > 0; minute--) collector.restore(history, now - minute * 60_000);
  expect(collector.databaseBudget.used).toBeLessThanOrEqual(collector.databaseBudget.limit / 2);
  expect(collector.budget.dropped).toBeGreaterThan(0);
  collector.measure(2, 18, false, 0, 1000);
  collector.recordDatabase(databaseMetric("thread.read", "execute"), 34, false, 0, now);
  const rollup = collector.rollup(now)!;
  expect(rollup.measures.find((row) => row.metricId === 2)?.last).toBe(18);
  expect(rollup.measures.find((row) => row.metricId === databaseMetric("thread.read", "execute"))?.histogram?.max).toBe(
    34,
  );
});
