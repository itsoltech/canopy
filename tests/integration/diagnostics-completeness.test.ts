import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import {
  DATABASE_FAMILIES,
  DATABASE_PHASES,
  databaseMetric,
  health,
  sufficientDiagnostics,
} from "@canopy/domain/diagnostics";
import { startTestGateway } from "./support/gateway.ts";
import { RpcCollector } from "../../apps/gateway/src/diagnostics/collector.ts";
import { DiagnosticsPersistence } from "../../apps/gateway/src/diagnostics/persistence.ts";
import { DiagnosticsStore } from "../../apps/gateway/src/diagnostics/store.ts";
import { registered } from "../../apps/gateway/src/diagnostics/registry.ts";
import { rpcSnapshot } from "../../apps/gateway/src/diagnostics/snapshot.ts";

const method = registered(ui.GatewayService.method.getClientCapabilities);

const host = {
  state: () => ({ findings: [], watermarks: [], peerOverviews: [] }),
  restore: () => {},
  restoreProcess: () => {},
  processes: () => [],
};

describe.skipIf(!dockerAvailable)("diagnostics completeness across gateway restarts", () => {
  test("reads saved coverage before a short restart and keeps the selected range sufficient", async () => {
    let gateway = await startTestGateway({ diagnostics: true });

    try {
      const end = Math.floor(Date.now() / 60_000) * 60_000;
      let now = end - 60 * 60_000;
      const collector = new RpcCollector([method], { utc: () => now, monotonic: () => now });

      const writer = new DiagnosticsPersistence(
        new DiagnosticsStore(gateway.runtime, gateway.userId, "local"),
        collector,
        host,
      );

      await writer.start();

      for (let index = 0; index < 1100; index++)
        collector.recordDatabase(databaseMetric("thread.read", "execute"), 12, false, method.id, now);

      for (; now < end - 30_000; now += 5000) {
        collector.tick();
        collector.start(method.id)!.finish();
        collector.measure(2, 10, false, 0, 5000);

        if (now % 60_000 === 0)
          for (const family of DATABASE_FAMILIES.slice(0, 12))
            for (const phase of DATABASE_PHASES)
              collector.recordDatabase(databaseMetric(family.name, phase), 12, false, method.id, now);
      }

      collector.tick();
      await writer.stop();

      const storage = {
        pg: gateway.pg,
        secretsKey: gateway.secretsKey,
        workerId: gateway.workerId,
        workerCredential: gateway.workerCredential,
      };

      await gateway.close(true);
      gateway = await startTestGateway({ diagnostics: true, storage });
      await gateway.core.diagnostics.start();
      await gateway.core.diagnostics.persistence?.start();
      const snapshot = await gateway.api.getComputerDiagnostics({ windowMinutes: 15 });
      expect(snapshot.restoring).toBe(false);
      expect(snapshot.observedSeconds).toBeGreaterThanOrEqual(13 * 60);
      expect(snapshot.calls.find((call) => call.method === method.name)?.completed).toBeGreaterThan(150n);
      expect(snapshot.gatewayMeasures.find((measure) => measure.metricId === 2)?.mean).toBe(10);
      expect(sufficientDiagnostics(snapshot)).toBe(true);
      expect(health(snapshot)).toBe("No issues found");
      expect(snapshot.droppedSamples).toBe(0n);
      expect(snapshot.limitReasons).toEqual([]);
      // The restore allowance sheds older SQL detail, outside the selected 15 min.
      expect(gateway.core.diagnostics.collector.budget.dropped).toBeGreaterThan(0);
      expect(snapshot.gaps.some((gap) => Number(gap.startMs) === end - 30_000)).toBe(true);
      expect(snapshot.windowStartMs).toBeLessThan(BigInt(end));
      const day = await gateway.api.getComputerDiagnostics({ windowMinutes: 1440 });
      expect(day.droppedSamples).toBeGreaterThan(0n);
      expect(day.limitReasons).toContain("sql_buffer");
    } finally {
      await gateway.close();
    }
  }, 60_000);
});

test("steady collection expires old loss flags without resetting lifetime counters", () => {
  let now = 0;
  const collector = new RpcCollector([method], { utc: () => now, monotonic: () => now });

  // A startup burst really overflows SQL buffering, then ordinary work continues.
  for (let index = 0; index < 1100; index++)
    collector.recordDatabase(databaseMetric("thread.read", "execute"), 12, false, method.id, now);
  const initial = rpcSnapshot(collector, 15);
  expect(initial.droppedSamples).toBeGreaterThan(0n);
  expect(initial.limitReasons).toContain("sql_buffer");

  for (now = 5000; now <= 90 * 60_000; now += 5000) {
    collector.tick();
    collector.start(method.id)!.finish();
    collector.measure(2, 10, false, 0, 5000);

    for (const family of ["thread.read", "thread.page", "other"] as const)
      collector.recordDatabase(databaseMetric(family, "execute"), 12, false, method.id, now);

    if (now === 20 * 60_000) {
      expect(rpcSnapshot(collector, 15).droppedSamples).toBe(0n);
      expect(rpcSnapshot(collector, 60).limitReasons).toContain("sql_buffer");
    }
  }

  const snapshot = create(ui.ComputerDiagnosticsSchema, {
    ...rpcSnapshot(collector, 15),
    status: "online",
    windowMinutes: 15,
  });

  expect(collector.budget.dropped).toBeGreaterThan(0);
  expect(snapshot.droppedSamples).toBe(0n);
  expect(snapshot.limitReasons).toEqual([]);
  expect(health(snapshot)).toBe("No issues found");
  expect(snapshot.database.every((family) => !family.incomplete)).toBe(true);

  for (const windowMinutes of [1, 15, 60, 1440]) {
    snapshot.windowMinutes = windowMinutes;
    snapshot.observedSeconds = windowMinutes * 60 * 0.75;
    expect(health(snapshot)).toBe("No issues found");
    snapshot.observedSeconds--;
    expect(health(snapshot)).toBe("Not enough data");
  }

  snapshot.windowMinutes = 15;
  snapshot.observedSeconds = 14 * 60;
  snapshot.droppedSamples = 1n;
  expect(health(snapshot)).toBe("Partial data");
});
