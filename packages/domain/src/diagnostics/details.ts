import type { ui } from "@canopy/contracts";
import { METRIC_DEFINITIONS, type MetricDefinition } from "./metrics.ts";
import { duration, measured } from "./presentation.ts";

export const metricGroups = [
  { id: "process", title: "Gateway process" },
  { id: "database", title: "Database pool" },
  { id: "queues", title: "Ingest and subscriptions" },
  { id: "governor", title: "Process governor" },
] as const;

export function metricValue(value: number, unit: MetricDefinition["unit"]) {
  if (unit === "ms") return duration(value);

  if (unit === "bytes") return `${(value / 1024 / 1024).toFixed(2)} MiB`;

  if (unit === "seconds") return `${Math.floor(value / 60)} min`;

  return `${value.toFixed(unit === "%" ? 1 : 2)}${unit === "%" ? "% of one core" : ""}`;
}

export function metricRows(measure: ui.DiagnosticsMeasure): [string, string][] {
  const definition = METRIC_DEFINITIONS.get(measure.metricId);

  if (!definition) return [];

  if (definition.kind === "timing")
    return [
      ["p50 / p95", `${measured(measure.distribution, "p50")} / ${measured(measure.distribution)}`],
      ["p99 / max", `${measured(measure.distribution, "p99")} / ${measured(measure.distribution, "max")}`],
      ["Samples / errors", `${measure.distribution?.samples ?? 0n} / ${measure.errors}`],
    ];

  if (definition.kind === "counter") return [["Count", measure.events.toString()]];
  const format = (value: number) => metricValue(value, definition.unit);

  return [
    [measure.historical ? "Last known" : "Latest", format(measure.last)],
    ["Mean / max", `${measure.observedSeconds ? format(measure.mean) : "Not measured"} / ${format(measure.max)}`],
    ["Time observed", `${measure.observedSeconds.toFixed(0)} s`],
  ];
}

export function cpuSummary(computer: ui.ComputerDiagnostics) {
  const cpu = computer.gatewayMeasures.find((value) => value.metricId === 2);

  return cpu
    ? `${metricValue(cpu.last, "%")}${cpu.historical || computer.status !== "online" ? " · Last known" : ""}`
    : "Not measured";
}

export function databaseRows(family: ui.DiagnosticsDatabaseFamily): [string, string][] {
  return (
    [
      ["Reserve", family.reserveMs, family.reserveErrors],
      ["Execute", family.executeMs, family.executeErrors],
      ["Release", family.releaseMs, family.releaseErrors],
      ["Transaction", family.transactionMs, family.transactionErrors],
    ] as const
  ).flatMap(([name, timing, errors]) => [
    [`${name} p50 / p95`, `${measured(timing, "p50")} / ${measured(timing)}`],
    [`${name} p99 / max`, `${measured(timing, "p99")} / ${measured(timing, "max")}`],
    [`${name} samples / errors`, `${timing?.samples ?? 0n} / ${errors}`],
  ]);
}

export function databaseCoverage(computer: ui.ComputerDiagnostics) {
  const total = computer.gatewayMeasures.find((value) => value.metricId === 11)?.events ?? 0n;
  const other = computer.gatewayMeasures.find((value) => value.metricId === 10)?.events ?? 0n;

  return total
    ? `${((100 * Number(total - other)) / Number(total)).toFixed(1)}% of ${total} queries have a named family. The rest are other.`
    : "Query family coverage: not measured.";
}

export const histogramHelp =
  "Percentiles use fixed histogram buckets with up to 19% quantization. Max is exact. p99 below 1,000 samples has a small sample.";

export const databaseHelp =
  "Up to 10 families, sorted by execute p95. Reserve includes waiting for a connection; execute includes decoding; release measures returning it. Transaction time overlaps these phases. Percentiles cannot be subtracted or added.";
