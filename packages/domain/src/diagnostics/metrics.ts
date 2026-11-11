export type MetricDefinition = {
  id: number;
  name: string;
  group: "process" | "queues" | "governor" | "database";
  unit: "ms" | "bytes" | "%" | "count" | "seconds";
  kind: "gauge" | "timing" | "counter";
  approximate?: boolean;
};

// Persisted IDs are stable. Append definitions; never reuse an ID.
const PROCESS_METRICS: MetricDefinition[] = [
  { id: 1, name: "Event-loop lag", group: "process", unit: "ms", kind: "timing" },
  { id: 2, name: "CPU", group: "process", unit: "%", kind: "gauge" },
  { id: 3, name: "RSS", group: "process", unit: "bytes", kind: "gauge" },
  { id: 4, name: "Heap used", group: "process", unit: "bytes", kind: "gauge" },
  { id: 5, name: "Heap total", group: "process", unit: "bytes", kind: "gauge" },
  { id: 6, name: "Uptime", group: "process", unit: "seconds", kind: "gauge" },
  { id: 7, name: "Pool waiting", group: "database", unit: "count", kind: "gauge" },
  { id: 8, name: "Pool occupied", group: "database", unit: "count", kind: "gauge" },
  { id: 9, name: "Pool capacity", group: "database", unit: "count", kind: "gauge" },
  { id: 10, name: "Unclassified queries", group: "database", unit: "count", kind: "counter" },
  { id: 11, name: "Database queries", group: "database", unit: "count", kind: "counter" },
  { id: 12, name: "Pool wait", group: "database", unit: "ms", kind: "timing" },
  { id: 20, name: "Events received", group: "queues", unit: "count", kind: "counter" },
  { id: 21, name: "Events committed", group: "queues", unit: "count", kind: "counter" },
  { id: 22, name: "Event receive to ACK", group: "queues", unit: "ms", kind: "timing" },
  { id: 23, name: "Ingest waiting", group: "queues", unit: "count", kind: "gauge" },
  { id: 24, name: "Ingest active", group: "queues", unit: "count", kind: "gauge" },
  { id: 25, name: "Oldest waiting event", group: "queues", unit: "ms", kind: "gauge" },
  { id: 26, name: "Outbox page depth", group: "queues", unit: "count", kind: "gauge", approximate: true },
  { id: 27, name: "Oldest outbox command", group: "queues", unit: "ms", kind: "gauge", approximate: true },
  { id: 28, name: "Thread watches", group: "queues", unit: "count", kind: "gauge" },
  { id: 29, name: "Overview watches", group: "queues", unit: "count", kind: "gauge" },
  { id: 30, name: "Revision reads", group: "queues", unit: "count", kind: "counter" },
  { id: 31, name: "Publications", group: "queues", unit: "count", kind: "counter" },
  { id: 32, name: "Delivery attempts", group: "queues", unit: "count", kind: "counter" },
  { id: 33, name: "Recipients per publication", group: "queues", unit: "count", kind: "gauge" },
  { id: 34, name: "Largest watch queue", group: "queues", unit: "count", kind: "gauge" },
  { id: 35, name: "Largest watch queue size", group: "queues", unit: "bytes", kind: "gauge" },
  { id: 36, name: "Watch overflows", group: "queues", unit: "count", kind: "counter" },
  { id: 37, name: "Governor active", group: "governor", unit: "count", kind: "gauge" },
  { id: 38, name: "Governor queued", group: "governor", unit: "count", kind: "gauge" },
  { id: 39, name: "Events started", group: "queues", unit: "count", kind: "counter" },
  { id: 40, name: "Mirror watches", group: "queues", unit: "count", kind: "gauge" },
];

export const DATABASE_FAMILIES = [
  { id: 0, name: "other" },
  { id: 1, name: "thread.page" },
  { id: 2, name: "watch.revision" },
  { id: 3, name: "commands.pending" },
  { id: 4, name: "commands.write" },
  { id: 5, name: "ingest.events" },
  { id: 6, name: "thread.read" },
  { id: 7, name: "turns.read" },
  { id: 8, name: "queue.read" },
  { id: 9, name: "diagnostics.history" },
  { id: 10, name: "diagnostics.write" },
  { id: 11, name: "workers.read" },
  { id: 12, name: "threads.metadata" },
  { id: 13, name: "threads.create" },
  { id: 14, name: "threads.lifecycle" },
  { id: 15, name: "events.history" },
  { id: 16, name: "turns.store" },
  { id: 17, name: "projects.store" },
  { id: 18, name: "workers.store" },
  { id: 19, name: "settings.store" },
  { id: 20, name: "computers.store" },
  { id: 21, name: "mirrors.write" },
  { id: 22, name: "bots.store" },
  { id: 23, name: "bots.queue" },
  { id: 24, name: "bots.harness" },
  { id: 25, name: "github.accounts" },
  { id: 26, name: "github.cache" },
  { id: 27, name: "github.pull_requests" },
  { id: 28, name: "connectors.store" },
  { id: 29, name: "retention.prune" },
  { id: 30, name: "worktrees.store" },
  { id: 31, name: "interactions.store" },
  { id: 32, name: "secrets.store" },
  { id: 33, name: "agents.store" },
  { id: 34, name: "imports.store" },
  { id: 35, name: "models.store" },
  { id: 36, name: "goals.store" },
  { id: 37, name: "attachments.store" },
  { id: 38, name: "background.store" },
  { id: 39, name: "updates.store" },
] as const;

export type DatabaseFamily = (typeof DATABASE_FAMILIES)[number]["name"];

export const DATABASE_PHASES = ["reserve", "execute", "release", "transaction"] as const;

export type DatabasePhase = (typeof DATABASE_PHASES)[number];

export function databaseMetric(family: DatabaseFamily, phase: DatabasePhase) {
  return 1000 + DATABASE_FAMILIES.find((value) => value.name === family)!.id * 8 + DATABASE_PHASES.indexOf(phase);
}

export const GOVERNOR_KINDS = ["git", "probe", "install", "utility", "harness", "supervisor"] as const;
export const GOVERNOR_PRIORITIES = ["user", "background"] as const;

export const GOVERNOR_EVENTS = [
  "attempt",
  "admitted",
  "wait",
  "execution",
  "full",
  "timeout",
  "cancelled",
  "evicted",
  "joined",
  "cached",
] as const;

export function governorMetric(
  kind: (typeof GOVERNOR_KINDS)[number],
  priority: (typeof GOVERNOR_PRIORITIES)[number],
  event: (typeof GOVERNOR_EVENTS)[number],
) {
  return (
    2000 +
    GOVERNOR_KINDS.indexOf(kind) * 32 +
    GOVERNOR_PRIORITIES.indexOf(priority) * 16 +
    GOVERNOR_EVENTS.indexOf(event)
  );
}

export const METRIC_DEFINITIONS: ReadonlyMap<number, MetricDefinition> = new Map(
  [
    ...PROCESS_METRICS,
    ...DATABASE_FAMILIES.flatMap((family) =>
      DATABASE_PHASES.map((phase): MetricDefinition => ({
        id: databaseMetric(family.name, phase),
        name: `${family.name} · ${phase}`,
        group: "database",
        unit: "ms",
        kind: "timing",
      })),
    ),
    ...GOVERNOR_KINDS.flatMap((kind) =>
      GOVERNOR_PRIORITIES.flatMap((priority) =>
        GOVERNOR_EVENTS.map((event): MetricDefinition => ({
          id: governorMetric(kind, priority, event),
          name: `${kind} · ${priority} · ${event}`,
          group: "governor",
          unit: event === "wait" || event === "execution" ? "ms" : "count",
          kind: event === "wait" || event === "execution" ? "timing" : "counter",
        })),
      ),
    ),
  ].map((value) => [value.id, value]),
);
