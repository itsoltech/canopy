import type { MetricDefinition } from "./metrics.ts";
import { CLIENT_SOURCES, type ClientSource } from "./client-source.ts";
import { THREAD_WATCH_REASONS, type ThreadWatchFailure } from "../thread-watch-recovery.ts";

const titles = [
  "Thread update too large",
  "Missing thread updates",
  "Invalid thread sync position",
  "Unreadable thread update",
  "Thread access unavailable",
  "Thread computer unreachable",
  "Thread connection dropped",
  "Thread updates timed out",
  "Thread watch failed",
  "Invalid thread record",
  "Thread watch RPC code",
  "Thread watch frame bytes",
];

// The existing client block ends at 363; these fixed series fit below 400.
export const threadWatchMetric = (source: ClientSource, index: number) =>
  364 + CLIENT_SOURCES.indexOf(source) * 12 + index;

export const threadWatchSource = (id: number) =>
  id >= 364 && id < 400 ? CLIENT_SOURCES[Math.floor((id - 364) / 12)] : undefined;

export const threadWatchCounter = (id: number) => !!threadWatchSource(id) && (id - 364) % 12 < 10;

export const THREAD_WATCH_METRICS: MetricDefinition[] = CLIENT_SOURCES.slice(0, 3).flatMap((source) =>
  titles.map((title, index) => ({
    id: threadWatchMetric(source, index),
    name: `${source} · ${title}`,
    group: "clients",
    kind: index < 10 ? "counter" : "gauge",
    unit: index === 11 ? "bytes" : "count",
  })),
);

export function recordThreadWatchFailure(
  measurements: { source: ClientSource; recordId: (id: number, value: number) => void },
  failure: ThreadWatchFailure,
  reason: string,
) {
  const index = THREAD_WATCH_REASONS.findIndex((value) => value === reason);
  measurements.recordId(threadWatchMetric(measurements.source, index < 0 ? 8 : index), 1);
  measurements.recordId(threadWatchMetric(measurements.source, 10), failure.code);

  if (failure.frameBytes) measurements.recordId(threadWatchMetric(measurements.source, 11), failure.frameBytes);
}
