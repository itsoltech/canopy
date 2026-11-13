import type { MetricDefinition } from "./metrics.ts";
import type { ui } from "@canopy/contracts";
import { THREAD_WATCH_METRICS, threadWatchCounter, threadWatchSource } from "./thread-watch.ts";
import { CLIENT_SOURCES, type ClientSource } from "./client-source.ts";

export { CLIENT_SOURCES, type ClientSource } from "./client-source.ts";

const sourceTitles = { web: "Web", desktop: "Desktop", mobile: "Mobile", bff: "BFF" };

export function clientGroups(measures: readonly ui.DiagnosticsMeasure[]) {
  return CLIENT_SOURCES.flatMap((source) => {
    const rows = measures.filter(
      (row) => (threadWatchSource(row.metricId) ?? CLIENT_SOURCES[Math.floor((row.metricId - 300) / 16)]) === source,
    );

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
  "Thread current state visible",
  "Warm cache hit",
  "Background thread requests",
  "Thread cache payload",
] as const;

const units = new Map<number, MetricDefinition["unit"]>([
  [10, "count"],
  [11, "bytes"],
  [13, "%"],
  [14, "count"],
  [15, "bytes"],
]);

export const clientCounter = (id: number) =>
  threadWatchSource(id) ? threadWatchCounter(id) : [10, 11, 14].includes((id - 300) % 16);

export const CLIENT_METRICS: MetricDefinition[] = [
  ...CLIENT_SOURCES.flatMap((source, index) =>
    names.flatMap((name, metric): MetricDefinition[] => {
      if (
        (source === "mobile" && [3, 4].includes(metric)) ||
        (source !== "mobile" && metric === 5) ||
        (source !== "bff" && metric >= 6 && metric <= 11) ||
        (source === "bff" && (metric < 6 || metric > 11))
      )
        return [];

      return [
        {
          id: 300 + index * 16 + metric,
          name: `${source === "bff" ? "BFF" : source} · ${source === "mobile" && metric === 2 ? "First snapshot reducer" : name}`,
          group: "clients",
          unit: units.get(metric) ?? "ms",
          kind: [10, 11, 14].includes(metric) ? "counter" : [13, 15].includes(metric) ? "gauge" : "timing",
          approximate: true,
        },
      ];
    }),
  ),
  ...THREAD_WATCH_METRICS,
];

export const clientMetric = (source: ClientSource, metric: number) =>
  300 + CLIENT_SOURCES.indexOf(source) * 16 + metric;

export const clientMetricIds = (source: ClientSource) =>
  new Set(
    CLIENT_METRICS.flatMap((metric) =>
      (threadWatchSource(metric.id) ?? CLIENT_SOURCES[Math.floor((metric.id - 300) / 16)]) === source
        ? [metric.id]
        : [],
    ),
  );
