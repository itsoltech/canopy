import { Metric } from "effect";

/** Fixed labels only. No owner, repository, URL, token or content enters telemetry. */
export const githubMetrics = {
  latency: Metric.histogram("github_read_latency_ms", {
    boundaries: Metric.exponentialBoundaries({ start: 1, factor: 2, count: 16 }),
  }),
  bytes: Metric.counter("github_cache_bytes_read"),
  hits: Metric.counter("github_cache_hits"),
  misses: Metric.counter("github_cache_misses"),
  remaining: Metric.gauge("github_rate_remaining"),
  backoff: Metric.gauge("github_backoff_ms"),
  evicted: Metric.counter("github_cache_evictions"),
};
