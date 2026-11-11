import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import {
  DATABASE_FAMILIES,
  databaseMetric,
  METRIC_DEFINITIONS,
  Measure,
  metricOf,
  rpcOf,
  percentiles,
} from "@canopy/domain/diagnostics";
import type { RpcCollector } from "./collector.ts";
import type { Slot } from "./buckets.ts";

function databaseFamilies(values: Map<number, Measure>, rpc: number) {
  return DATABASE_FAMILIES.flatMap((family) => {
    const phases = ["reserve", "execute", "release", "transaction"] as const;
    const measures = phases.map((phase) => values.get(databaseMetric(family.name, phase) * 0x1_0000_0000 + rpc));

    if (!measures.some((value) => value?.events)) return [];
    const distributions = measures.map((value) => percentiles(value?.histogram ? [value.histogram.snapshot()] : []));

    return [
      create(ui.DiagnosticsDatabaseFamilySchema, {
        family: family.name,
        reserveMs: distributions[0],
        executeMs: distributions[1],
        releaseMs: distributions[2],
        transactionMs: distributions[3],
        reserveErrors: measures[0]?.errors ?? 0n,
        executeErrors: measures[1]?.errors ?? 0n,
        releaseErrors: measures[2]?.errors ?? 0n,
        transactionErrors: measures[3]?.errors ?? 0n,
        incomplete: measures.some((value) => value?.incomplete || value?.histogram?.incomplete),
      }),
    ];
  })
    .sort((a, b) => (b.executeMs?.p95 ?? 0) - (a.executeMs?.p95 ?? 0))
    .slice(0, 10);
}

/** Uses the existing transient window budget; no second ring or hourly cache. */
export function measureSnapshot(collector: RpcCollector, minutes: number, hourly?: Slot) {
  const now = collector.clock.utc();
  let width = 60_000;

  if (minutes === 1) width = 5000;

  if (minutes === 1440) width = 3_600_000;

  const start =
    minutes === 1440 ? Math.floor(now / width) * width : Math.floor(now / width) * width - minutes * 60_000 + width;

  const slots =
    minutes === 1
      ? collector.short.between(start, now + 1)
      : [...collector.minutes.between(start, now + 1), ...collector.historyMinutes.between(start, now + 1)];

  if (hourly) slots.push(hourly);
  const values = new Map<number, Measure>();
  let reserved = 0;

  const reserve = (bytes: number) => {
    if (!collector.windowBudget.reserve(bytes)) {
      collector.budget.dropped++;

      return false;
    }

    reserved += bytes;

    return true;
  };

  try {
    for (const slot of slots)
      for (const [key, value] of slot.measures ?? []) {
        let measure = values.get(key);

        if (!measure) {
          if (!reserve(256)) continue;
          measure = new Measure(reserve);
          values.set(key, measure);
        }

        measure.merge(value);
      }

    const gatewayMeasures = [...values].flatMap(([key, value]) => {
      const metricId = metricOf(key);

      if (rpcOf(key) || (metricId >= 1000 && metricId < 2000)) return [];

      return [
        create(ui.DiagnosticsMeasureSchema, {
          metricId,
          distribution: value.histogram ? percentiles([value.histogram.snapshot()]) : undefined,
          events: value.events,
          errors: value.errors,
          mean: value.weight ? value.weightedSum / value.weight : value.last,
          max: value.max,
          last: value.last,
          sampledAtMs: value.sampledAtMs,
          observedSeconds: value.weight / 1000,
          historical: Number(value.sampledAtMs) < collector.startedAt || now - Number(value.sampledAtMs) > 10_000,
          incomplete: value.incomplete,
        }),
      ];
    });

    const associated = new Map<number, ui.DiagnosticsDatabaseFamily[]>();
    const rpcs = new Set([...values.keys()].flatMap((key) => (rpcOf(key) ? [rpcOf(key)] : [])));

    for (const rpc of rpcs) associated.set(rpc, databaseFamilies(values, rpc));

    return { gatewayMeasures, database: databaseFamilies(values, 0), associated };
  } finally {
    collector.windowBudget.used -= reserved;
  }
}

export function restoreMeasures(
  slot: Slot,
  process: ui.DiagnosticsProcess,
  reserve: (bytes: number) => boolean,
  allowedRpc: (id: number) => boolean,
) {
  for (const series of process.measures) {
    if (!METRIC_DEFINITIONS.has(series.metricId) || (series.rpcMethodId && !allowedRpc(series.rpcMethodId))) continue;
    const key = series.metricId * 0x1_0000_0000 + series.rpcMethodId;
    let value = slot.measures?.get(key);

    if (!value) {
      if (!reserve(256)) continue;
      value = new Measure(reserve);
      slot.measures ??= new Map();
      slot.measures.set(key, value);
    }

    value.merge(series);
  }
}
