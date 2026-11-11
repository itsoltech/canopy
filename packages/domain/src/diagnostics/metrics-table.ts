import type { ui } from "@canopy/contracts";
import { METRIC_DEFINITIONS, type MetricDefinition } from "./metrics.ts";
import { duration } from "./presentation.ts";

export const workerTurnHelp = "Turn timings include CLI, tools and inference.";
export const workerResourceHelp = "CLI memory and provider network time are unmeasured.";
export const workerReplayHelp = "Replay after restart may be unclassified.";

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0, useGrouping: false });

const decimal = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  useGrouping: false,
});

function compactNumber(value: number) {
  return (value > 0 && value < 10 ? decimal : integer).format(value);
}

function compactValue(value: number, unit: MetricDefinition["unit"]) {
  if (unit === "ms") return duration(value);

  if (unit === "seconds") {
    if (value >= 86400) return `${compactNumber(value / 86400)} d`;

    if (value >= 3600) return `${compactNumber(value / 3600)} h`;

    return `${integer.format(Math.floor(value / 60))} min`;
  }

  if (unit === "bytes") {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const index = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log2(value || 1) / 10)));

    return `${compactNumber(value / 1024 ** index)} ${units[index]}`;
  }

  return `${compactNumber(value)}${unit === "%" ? "%" : ""}`;
}

/** Shared presentation only: gauges have Last/Mean/Max; uptime has no distribution. */
export function metricsTableRows(measures: readonly ui.DiagnosticsMeasure[]) {
  return measures.flatMap((measure) => {
    const definition = METRIC_DEFINITIONS.get(measure.metricId);

    if (definition?.kind !== "gauge") return [];
    const format = (value: number) => compactValue(value, definition.unit);
    const uptime = measure.metricId === 6;

    return [
      {
        id: measure.metricId,
        name: definition.unit === "%" ? `${definition.name} (% of one core)` : definition.name,
        description: definition.unit === "%" ? `${definition.name} (% of one core)` : definition.name,
        last: measure.events ? format(measure.last) : "—",
        mean: uptime ? "" : measure.observedSeconds ? format(measure.mean) : "—",
        max: uptime ? "" : measure.events ? format(measure.max) : "—",
        historical: measure.historical,
        incomplete: measure.incomplete,
        approximate: definition.approximate ?? false,
      },
    ];
  });
}
