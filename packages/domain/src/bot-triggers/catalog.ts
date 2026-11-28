/**
 * Event types a bot can subscribe to with an event trigger: a closed list. Each type names the scope kinds that
 * narrow it, the fields its conditions can test, and whether the gateway keeps history for a preview.
 */

export const SCOPE_KINDS = [
  "project",
  "worker",
  "thread",
  "schedule",
  "repository",
  "pull_request",
  "profile",
] as const;

export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** The scope kind named by a stored string, if any. */
export const scopeKind = (value: string) => SCOPE_KINDS.find((kind) => kind === value);

export type FieldSpec =
  | { kind: "enum"; values: readonly string[]; label: string }
  | { kind: "number"; label: string; crossing?: boolean }
  | { kind: "string"; label: string }
  | { kind: "boolean"; label: string };

export interface EventType {
  name: string;
  /** Plain words for descriptions, e.g. "a thread turn finishes". */
  label: string;
  /** Kinds the scope may use. */
  scopeKinds: readonly ScopeKind[];
  /** At least one of these kinds must list a resource. */
  requiredAny: readonly ScopeKind[];
  /** Each of these kinds must list a resource. */
  requiredAll: readonly ScopeKind[];
  fields: Readonly<Record<string, FieldSpec>>;
  /** Fields whose condition is required (e.g. a usage threshold). */
  requiredFields: readonly string[];
  /** The source keeps past events, so a preview can estimate how often the trigger fires. */
  history: boolean;
  /** Needs the Threads module besides Bots. */
  threads: boolean;
  /** How to name the scope's resources, when the list tools do not give the id as is. */
  note?: string;
}

const TURN_STATUSES = ["completed", "failed", "interrupted"] as const;

export const EVENT_TYPES: readonly EventType[] = [
  {
    name: "thread.turn_finished",
    label: "a thread turn finishes",
    scopeKinds: ["project", "worker", "thread"],
    requiredAny: ["project", "worker", "thread"],
    requiredAll: [],
    fields: {
      status: { kind: "enum", values: TURN_STATUSES, label: "status" },
      thread_origin: { kind: "enum", values: ["user", "agent", "schedule"], label: "thread started by" },
    },
    requiredFields: [],
    history: true,
    threads: true,
  },
  {
    name: "thread.needs_input",
    label: "a thread waits for your answer or approval",
    scopeKinds: ["project", "worker", "thread"],
    requiredAny: ["project", "worker", "thread"],
    requiredAll: [],
    fields: {
      kind: { kind: "enum", values: ["permission", "question", "elicitation"], label: "request" },
      tool_name: { kind: "string", label: "tool" },
    },
    requiredFields: [],
    history: true,
    threads: true,
  },
  {
    name: "pr.checks",
    label: "CI of a watched pull request reports",
    scopeKinds: ["project", "repository", "pull_request"],
    requiredAny: ["project", "repository", "pull_request"],
    requiredAll: [],
    fields: {
      event: { kind: "enum", values: ["failure", "each", "complete", "ended"], label: "report" },
      reason: {
        kind: "enum",
        values: ["passed", "conflict", "merged", "closed", "timeout", "no_checks", "access", "unlinked"],
        label: "end reason",
      },
      failed_count: { kind: "number", label: "failed checks" },
      automatic: { kind: "boolean", label: "automatic watch" },
    },
    requiredFields: [],
    history: true,
    threads: true,
  },
  {
    name: "schedule.run",
    label: "a schedule run is skipped, expires or finishes",
    scopeKinds: ["schedule", "project"],
    requiredAny: ["schedule", "project"],
    requiredAll: [],
    fields: {
      phase: { kind: "enum", values: ["skipped", "expired", "finished"], label: "phase" },
      status: { kind: "enum", values: TURN_STATUSES, label: "turn status" },
    },
    requiredFields: [],
    history: true,
    threads: true,
  },
  {
    name: "provider.limit",
    label: "a provider usage limit passes a threshold",
    scopeKinds: ["worker", "profile"],
    requiredAny: [],
    requiredAll: ["worker", "profile"],
    fields: {
      window: { kind: "string", label: "limit window" },
      // A threshold condition (gte) matches when an observation rises past it, not on every later one.
      used_percent: { kind: "number", label: "used percent", crossing: true },
    },
    requiredFields: ["window", "used_percent"],
    history: false,
    threads: false,
    note: "scope.profile ids are <harness>/<profile id> of a native profile, e.g. codex/default (from list_provider_instances). Name the window (e.g. five_hour) and a used_percent gte threshold; each window and reset reports once.",
  },
  {
    name: "habit.suggested",
    label: "a habit suggestion is ready to review",
    scopeKinds: ["project"],
    requiredAny: [],
    requiredAll: ["project"],
    fields: {},
    requiredFields: [],
    history: false,
    threads: false,
  },
];

export const eventType = (name: string) => EVENT_TYPES.find((type) => type.name === name);

export const SCOPE_LABELS: Readonly<Record<ScopeKind, string>> = {
  project: "project",
  worker: "worker",
  thread: "thread",
  schedule: "schedule",
  repository: "repository",
  pull_request: "pull request",
  profile: "provider profile",
};
