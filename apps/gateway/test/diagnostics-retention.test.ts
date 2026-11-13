import { expect, test } from "bun:test";
import { ui } from "@canopy/contracts";
import {
  DATABASE_FAMILIES,
  DATABASE_PHASES,
  databaseMetric,
  measureKey,
  type DatabaseFamily,
} from "@canopy/domain/diagnostics";
import { RpcCollector } from "../src/diagnostics/collector.ts";
import { registered } from "../src/diagnostics/registry.ts";

test("a 15 minute steady SQL workload retains counts and correlations inside the process budget", () => {
  let now = 0;
  const methods = [ui.GatewayService.method.getThread, ui.GatewayService.method.getOverview].map(registered);
  const collector = new RpcCollector(methods, { monotonic: () => now, utc: () => now });

  const families: DatabaseFamily[] = [
    "computers.store",
    "bots.store",
    "bots.queue",
    "settings.store",
    "thread.page",
    "agents.store",
    "mirrors.write",
    "workers.read",
    "diagnostics.write",
    "other",
    "secrets.store",
    "projects.store",
  ];

  for (let second = 0; second < 900; second++) {
    now = second * 1000;

    for (let query = 0; query < 325; query++) {
      const family = families[query % families.length]!;
      const rpc = query % 3 ? methods[query % methods.length]!.id : 0;

      for (const phase of ["reserve", "execute", "release"] as const)
        collector.recordDatabase(databaseMetric(family, phase), 0.05 * (1 + (query % 4)), false, rpc, now);
    }

    collector.tick();
  }

  const total = collector.minutes.slots.reduce(
    (sum, slot) => sum + (slot?.measures?.get(measureKey(11))?.events ?? 0n),
    0n,
  );

  expect(total).toBe(292_500n);
  expect(collector.budget.dropped).toBe(0);
  expect(collector.budget.used).toBeLessThanOrEqual(6 * 1024 * 1024);
  expect(collector.rollup(840_000)?.measures.some((value) => value.rpcMethodId === methods[0]!.id)).toBe(true);
});

test("drop rate uses observed time and excludes sleep gaps", () => {
  let now = 0;
  const collector = new RpcCollector([], { monotonic: () => now, utc: () => now });
  collector.budget.dropped = 100;
  now = 5000;
  collector.tick();
  const rate = collector.rollup(0)?.measures.find((value) => value.metricId === 45);
  expect(rate?.last).toBe(20);
  expect(rate?.weight).toBe(5000);
  collector.budget.dropped += 500;
  now += 60_000;
  collector.tick();
  expect(collector.rollup(60_000)?.measures.find((value) => value.metricId === 45)).toBeUndefined();
  now += 5000;
  collector.tick();
  expect(collector.rollup(60_000)?.measures.find((value) => value.metricId === 45)?.last).toBe(0);
});

test("global SQL families do not consume the optional RPC correlation allowance", () => {
  const methods = [ui.GatewayService.method.getThread, ui.GatewayService.method.getOverview].map(registered);
  const collector = new RpcCollector(methods, { monotonic: () => 0, utc: () => 0 });

  for (const family of DATABASE_FAMILIES)
    for (const phase of DATABASE_PHASES) collector.recordDatabase(databaseMetric(family.name, phase), 1, false, 0, 0);

  for (const family of DATABASE_FAMILIES.slice(0, 8))
    for (const phase of DATABASE_PHASES)
      for (const method of methods)
        collector.recordDatabase(databaseMetric(family.name, phase), 1, false, method.id, 0);

  const correlated = collector.rollup(0)?.measures.filter((value) => value.rpcMethodId);
  expect(correlated).toHaveLength(64);
  expect(collector.budget.dropped).toBe(0);
});
