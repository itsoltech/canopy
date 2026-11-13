import type { MetricDefinition } from "./metrics.ts";
import type { ui } from "@canopy/contracts";
import { THREAD_WATCH_METRICS, threadWatchCounter, threadWatchSource } from "./thread-watch.ts";
import { CLIENT_SOURCES, type ClientSource } from "./client-source.ts";

export { CLIENT_SOURCES, type ClientSource } from "./client-source.ts";

const sourceTitles = { web: "Web", desktop: "Desktop", mobile: "Mobile", bff: "BFF" };

// History recovery series follow the watch block (364–399) and worker git timings (400–409).
const metricSource = (id: number) =>
  id >= 450 && id < 456
    ? CLIENT_SOURCES[Math.floor((id - 450) / 2)]
    : (threadWatchSource(id) ?? CLIENT_SOURCES[Math.floor((id - 300) / 16)]);

export function clientGroups(measures: readonly ui.DiagnosticsMeasure[]) {
  return CLIENT_SOURCES.flatMap((source) => {
    const rows = measures.filter((row) => metricSource(row.metricId) === source);

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
  id >= 450 && id < 456
    ? (id - 450) % 2 === 0
    : threadWatchSource(id)
      ? threadWatchCounter(id)
      : [10, 11, 14].includes((id - 300) % 16);

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
  ...CLIENT_SOURCES.flatMap((source, index): MetricDefinition[] =>
    source === "bff"
      ? []
      : [
          {
            id: 450 + index * 2,
            name: `${source} · Timeline recoveries`,
            group: "clients",
            unit: "count",
            kind: "counter",
            approximate: true,
          },
          {
            id: 451 + index * 2,
            name: `${source} · Earlier work rendered`,
            group: "clients",
            unit: "ms",
            kind: "timing",
            approximate: true,
          },
        ],
  ),
];

export const clientMetric = (source: ClientSource, metric: number) =>
  metric === 16 || metric === 17
    ? 450 + CLIENT_SOURCES.indexOf(source) * 2 + metric - 16
    : 300 + CLIENT_SOURCES.indexOf(source) * 16 + metric;

export const clientMetricIds = (source: ClientSource) =>
  new Set(CLIENT_METRICS.flatMap((metric) => (metricSource(metric.id) === source ? [metric.id] : [])));
