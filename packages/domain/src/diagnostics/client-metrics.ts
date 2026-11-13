import type { MetricDefinition } from "./metrics.ts";
import type { ui } from "@canopy/contracts";

export const CLIENT_SOURCES = ["web", "desktop", "mobile", "bff"] as const;

export type ClientSource = (typeof CLIENT_SOURCES)[number];

const sourceTitles = { web: "Web", desktop: "Desktop", mobile: "Mobile", bff: "BFF" };

export function clientGroups(measures: readonly ui.DiagnosticsMeasure[]) {
  return CLIENT_SOURCES.flatMap((source, index) => {
    const rows = measures.filter((row) => Math.floor((row.metricId - 300) / 16) === index);

    return rows.length ? [{ source, title: sourceTitles[source], measures: rows }] : [];
  });
}

const names = [
  "Thread open (cache)",
  "Thread open (network)",
  "First snapshot processing",
  "Cold FCP",
  "Long task",
  "JS frame delay",
  "Local unary",
  "Remote unary",
  "First stream message",
  "Stream lifetime",
  "Stream messages",
  "Stream bytes",
] as const;

const units = new Map<number, MetricDefinition["unit"]>([
  [10, "count"],
  [11, "bytes"],
]);

export const CLIENT_METRICS: MetricDefinition[] = CLIENT_SOURCES.flatMap((source, index) =>
  names.flatMap((name, metric): MetricDefinition[] => {
    if (
      (source === "mobile" && [3, 4].includes(metric)) ||
      (source !== "mobile" && metric === 5) ||
      (source !== "bff" && metric >= 6) ||
      (source === "bff" && metric < 6)
    )
      return [];

    return [
      {
        id: 300 + index * 16 + metric,
        name: `${source === "bff" ? "BFF" : source} · ${source === "mobile" && metric === 2 ? "First snapshot reducer" : name}`,
        group: "clients",
        unit: units.get(metric) ?? "ms",
        kind: metric >= 10 ? "counter" : "timing",
        approximate: true,
      },
    ];
  }),
);

export const clientMetric = (source: ClientSource, metric: number) =>
  300 + CLIENT_SOURCES.indexOf(source) * 16 + metric;

export const clientMetricIds = (source: ClientSource) =>
  new Set(
    CLIENT_METRICS.flatMap((metric) =>
      Math.floor((metric.id - 300) / 16) === CLIENT_SOURCES.indexOf(source) ? [metric.id] : [],
    ),
  );
