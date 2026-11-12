import { heapStats } from "bun:jsc";
import { ProcessGovernor, PROCESS_LIMITS } from "@canopy/process-governor";
import { DATABASE_FAMILIES, DATABASE_PHASES, databaseMetric, GOVERNOR_KINDS } from "@canopy/domain/diagnostics";
import { RpcCollector } from "../../../apps/gateway/src/diagnostics/collector.ts";
import { governorObserver } from "../../../apps/gateway/src/diagnostics/process.ts";
import { RPC_METHODS } from "../../../apps/gateway/src/diagnostics/registry.ts";

let now = 1_800_000_000_000;
const collector = new RpcCollector(RPC_METHODS, { utc: () => now, monotonic: () => now });
const governor = new ProcessGovernor(PROCESS_LIMITS, 1, 1, 4, () => {});
const stop = governor.observe(governorObserver(collector));

async function cycle(index: number) {
  for (let minute = 0; minute < 72; minute++) {
    now += 60_000;
    collector.tick();

    for (const family of DATABASE_FAMILIES)
      for (const phase of DATABASE_PHASES)
        for (let rpc = 0; rpc < 8; rpc++)
          collector.recordDatabase(
            databaseMetric(family.name, phase),
            2 ** ((minute + rpc) % 20),
            rpc === 1,
            rpc ? RPC_METHODS[rpc]!.id : 0,
            now,
          );
    collector.flushDatabase();

    for (const kind of GOVERNOR_KINDS) {
      const gate = Promise.withResolvers<number>();
      const key = `${index}:${minute}:${kind}`;
      const running = governor.run({ kind, key, ttlMs: 60_000 }, () => gate.promise);
      const joined = governor.run({ kind, key }, async () => 0);
      const abort = new AbortController();
      const tasks = Array.from({ length: 6 }, (_, n) =>
        governor
          .run({ kind, key: `${key}:${n}`, signal: abort.signal, priority: "background" }, async () => n)
          .catch(() => -1),
      );
      abort.abort();
      gate.resolve(1);
      await Promise.all([running, joined, ...tasks]);
      await governor.run({ kind, key, ttlMs: 60_000 }, async () => 0);
    }

    governor.invalidate();
    collector.measure(37, governor.snapshot().active);
    collector.measure(38, governor.snapshot().queued);
    // Simulate persistence views, never keep their returned object graphs.
    collector.rollup(Math.floor(now / 60_000) * 60_000);
  }
}

async function sample(cycle: number) {
  await Bun.sleep(1);
  Bun.gc(true);
  await Bun.sleep(1);
  Bun.gc(true);
  const stats = heapStats();
  console.info(
    JSON.stringify({
      cycle,
      heap: process.memoryUsage().heapUsed,
      objects: stats.objectTypeCounts["Object"] ?? 0,
      measures: [collector.short, collector.minutes, collector.historyMinutes].reduce(
        (total, ring) => total + ring.slots.reduce((count, slot) => count + (slot?.measures?.size ?? 0), 0),
        0,
      ),
      histograms: [collector.short, collector.minutes, collector.historyMinutes].reduce(
        (total, ring) =>
          total +
          ring.slots.reduce(
            (count, slot) => count + [...(slot?.measures?.values() ?? [])].filter((value) => value.histogram).length,
            0,
          ),
        0,
      ),
      used: collector.budget.used,
      internal: collector.measureBudget.used,
      database: collector.databaseBudget.used,
      dropped: collector.budget.dropped,
      active: governor.snapshot().active,
      queued: governor.snapshot().queued,
      slots: collector.minutes.slots.filter(Boolean).length,
    }),
  );
}

for (let index = 0; index < 25; index++) {
  await cycle(index);
  if (index >= 4) await sample(index);
}
stop();
