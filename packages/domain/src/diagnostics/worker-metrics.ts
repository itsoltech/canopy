import type { MetricDefinition } from "./metrics.ts";

export const HARNESS_KINDS = ["claude", "codex", "grok"] as const;
export const GIT_FAMILIES = ["status", "refs", "fetch", "worktree", "other"] as const;

export type HarnessKind = (typeof HARNESS_KINDS)[number];

export type GitFamily = (typeof GIT_FAMILIES)[number];

export const harnessMetric = (
  kind: HarnessKind,
  event: "ttft" | "turn" | "human" | "queue" | "completed" | "interrupted" | "failed" | "unspecified",
) =>
  300 +
  HARNESS_KINDS.indexOf(kind) * 8 +
  ["ttft", "turn", "human", "queue", "completed", "interrupted", "failed", "unspecified"].indexOf(event);

export const gitMetric = (family: GitFamily, phase: "wait" | "execution") =>
  400 + GIT_FAMILIES.indexOf(family) * 2 + Number(phase === "execution");

export const WORKER_METRICS: MetricDefinition[] = [
  { id: 100, name: "Unacknowledged events", group: "journal", unit: "count", kind: "gauge" },
  { id: 101, name: "Unacknowledged bytes", group: "journal", unit: "bytes", kind: "gauge" },
  { id: 102, name: "Oldest unacknowledged event", group: "journal", unit: "ms", kind: "gauge" },
  { id: 103, name: "Send attempts", group: "journal", unit: "count", kind: "counter" },
  { id: 104, name: "Known redelivery attempts", group: "journal", unit: "count", kind: "counter" },
  { id: 105, name: "Unclassified replay attempts", group: "journal", unit: "count", kind: "counter" },
  { id: 106, name: "Acknowledged events", group: "journal", unit: "count", kind: "counter" },
  { id: 110, name: "Connection attempts", group: "journal", unit: "count", kind: "counter" },
  { id: 111, name: "Connections established", group: "journal", unit: "count", kind: "counter" },
  { id: 112, name: "Planned drains", group: "journal", unit: "count", kind: "counter" },
  { id: 113, name: "Route changes", group: "journal", unit: "count", kind: "counter" },
  { id: 114, name: "Transport failures", group: "journal", unit: "count", kind: "counter" },
  { id: 115, name: "Authentication failures", group: "journal", unit: "count", kind: "counter" },
  { id: 120, name: "Disk available", group: "storage", unit: "bytes", kind: "gauge" },
  { id: 121, name: "Disk total", group: "storage", unit: "bytes", kind: "gauge" },
  { id: 122, name: "Journal file size", group: "storage", unit: "bytes", kind: "gauge" },
  ...HARNESS_KINDS.flatMap((kind) =>
    (["ttft", "turn", "human", "queue"] as const).map((event): MetricDefinition => ({
      id: harnessMetric(kind, event),
      name: `${kind} · ${{ ttft: "First assistant text", turn: "Turn duration", human: "Waiting for a person", queue: "Before adapter" }[event]}`,
      group: "harness",
      unit: "ms",
      kind: "timing",
    })),
  ),
  ...GIT_FAMILIES.flatMap((family) =>
    (["wait", "execution"] as const).map((phase): MetricDefinition => ({
      id: gitMetric(family, phase),
      name: `${family} · ${phase}`,
      group: "git",
      unit: "ms",
      kind: "timing",
    })),
  ),
  ...HARNESS_KINDS.flatMap((kind) =>
    (["completed", "interrupted", "failed", "unspecified"] as const).map((outcome): MetricDefinition => ({
      id: harnessMetric(kind, outcome),
      name: `${kind} · ${outcome} turns`,
      group: "harness",
      unit: "count",
      kind: "counter",
    })),
  ),
];

export const SYNC_METRICS: MetricDefinition[] = [
  { id: 200, name: "Mirror detection to commit", group: "sync", unit: "ms", kind: "timing" },
  { id: 201, name: "Known pending mirror revisions", group: "sync", unit: "count", kind: "gauge" },
  { id: 202, name: "Time since mirror confirmation", group: "sync", unit: "ms", kind: "gauge" },
  { id: 203, name: "Mirror snapshots", group: "sync", unit: "count", kind: "counter" },
  { id: 204, name: "Mirror deltas", group: "sync", unit: "count", kind: "counter" },
  ...["revision", "gap", "stall", "legacy_probe", "stream_error"].map((reason, index): MetricDefinition => ({
    id: 210 + index,
    name: `Resubscribe · ${reason}`,
    group: "sync",
    unit: "count",
    kind: "counter",
  })),
  { id: 220, name: "Active linked thread watches", group: "sync", unit: "count", kind: "gauge" },
  { id: 221, name: "Thread snapshots", group: "sync", unit: "count", kind: "counter" },
  { id: 222, name: "Thread content updates", group: "sync", unit: "count", kind: "counter" },
];

export const WORKER_METRIC_IDS = new Set([2, 3, 4, 5, 6, ...WORKER_METRICS.map((value) => value.id)]);
export const SYNC_METRIC_IDS = new Set(SYNC_METRICS.map((value) => value.id));
