import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui, type Command } from "@canopy/contracts";
import { SPAWN_PERMISSION_MODES, type SpawnPermissionMode } from "@canopy/domain";
import { Effect, Predicate } from "effect";
import type { SqlError } from "effect/sql";
import { Invalid, NotFound, type ThreadRow, type TurnRow } from "./store.ts";

export class ScheduleConflict extends Error {
  override readonly name = "ScheduleConflict";
}

export type Fx<A> = Effect.Effect<A, SqlError.SqlError | NotFound | Invalid | ScheduleConflict>;

export interface BusCallRow {
  id: string;
  source_thread_id: string;
  tool: string;
  status: "requested" | "completed" | "failed";
  result: JsonValue | null;
  error: string | null;
  target_thread_id: string | null;
  target_turn_id: string | null;
  hops: number | null;
  notify: boolean;
}

export interface CallSource {
  readonly expiresAt?: Date;
  readonly callId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
}

/** What an agent sees about another thread: enough to decide, not the transcript. */
export interface ThreadSummary {
  readonly thread_id: string;
  readonly title: string;
  readonly kind: "main" | "side";
  readonly parent_thread_id: string | null;
  readonly status: string;
  /** Provider instance it runs on (as list_agents names it, e.g. "codex/native"). */
  readonly provider: string;
  /** Where it lives: shown for threads outside the caller's tree (list_threads scope all, cross-tree reads). */
  readonly project: string;
  readonly worker: string;
  /** Settled = nothing running or queued: the thread waits for new input. */
  readonly settled: boolean;
  readonly queued_turns: number;
  /** Questions and permission prompts of this thread waiting for its parent agent. */
  readonly waiting_for_parent: number;
  readonly waiting_for_user: number;
  /** What the thread runs with ('' = the provider's default). */
  readonly model: string;
  readonly effort: string;
  readonly permission_mode: SpawnPermissionMode;
  /** The latest finished turn: completed, interrupted, failed or cancelled, with the reason. Absent before the first one ends. */
  readonly last_turn?: { readonly turn_id: string; readonly status: string; readonly reason?: string };
  /** The latest finished turn's final message: a subagent's result (never output from a newer running turn). */
  readonly last_message: string;
}

/** Thread settings keep the contract's enum key (ASK, READ_ONLY, ...); the bus speaks lower case. */
/**
 * A stored mode in bus terms. Full access is not a bus mode: an agent never passes it on, so a Full access
 * caller counts as full_auto (its side threads and schedules run sandboxed, docs/agent-bus.md).
 */
export function busPermissionMode(stored: string | undefined): SpawnPermissionMode {
  const mode = (stored ?? "ASK").toLowerCase();

  if (mode === "full_access") return "full_auto";

  return SPAWN_PERMISSION_MODES.find((known) => known === mode) ?? "ask";
}

export interface Notification {
  readonly call: Pick<BusCallRow, "id" | "source_thread_id">;
  readonly target: Pick<ThreadRow, "id" | "title" | "kind">;
  readonly turnStatus: string;
  readonly lastMessage: string;
  readonly lastMessageLength: number;
}

export interface ScheduleRow {
  id: string;
  thread_id: string | null;
  kind: "once" | "recurring";
  prompt: string;
  run_at: Date | null;
  cron: string | null;
  timezone: string;
  until: Date | null;
  max_runs: number | null;
  runs: number;
  next_run_at: Date | null;
  missed_policy: "run_once" | "skip";
  status: string;
  hops: number;
  last_turn_id?: string | null;
  created_at?: Date;
  created_by_user_id?: string | null;
  project_id: string;
  /** Joined for schedules created through an agent-bus call. */
  created_by_thread_id?: string | null;
  target: "thread" | "new_thread";
  new_thread: JsonValue | null;
  concurrency: "allow" | "skip_if_running";
  name: string;
  placement_cursor: string | null;
  lease_owner: string | null;
  lease_until: Date | null;
  occurrence_at: Date | null;
  version: number;
  last_edited_by_user_id: string | null;
  last_edited_at: Date | null;
  recent_runs?: JsonValue[];
  owner_user_id?: string;
}

export interface NewSchedule {
  readonly threadId: string;
  readonly kind: "once" | "recurring";
  readonly prompt: string;
  readonly runAt?: Date;
  readonly cron?: string;
  readonly timezone: string;
  readonly until?: Date;
  readonly maxRuns?: number;
  readonly nextRunAt: Date;
  readonly hops: number;
  readonly missedPolicy?: "run_once" | "skip";
  readonly newThread?: ui.NewThreadSchedule;
  readonly concurrency?: "allow" | "skip_if_running";
  readonly name?: string;
}

export interface FiredSchedule {
  threadId: string;
  turn?: TurnRow;
  created?: { thread: ThreadRow; command: Command; newWorktree?: boolean };
}

/**
 * Input of a turn the platform queues: a note saying where it comes from, and the content (task, message,
 * report, scheduled prompt). The model gets both (input.text); the UI shows them apart.
 */
export interface TurnInput {
  readonly note: string;
  readonly message: string;
}

export function inputJson(input: TurnInput): string {
  return JSON.stringify({
    text: input.message ? `${input.note}\n\n${input.message}` : input.note,
    note: input.note,
    message: input.message,
  });
}

/** Where a thread's spawn_thread / send_message call went (ui.BusDelivery) and which thread hears about it. */
export interface DeliveryRow {
  call_id: string;
  source_thread_id: string;
  target_thread_id: string;
  target_turn_id: string | null;
  delivery: "queue" | "steer";
  status: string;
}

export function toUiDelivery(row: DeliveryRow): ui.BusDelivery {
  return create(ui.BusDeliverySchema, {
    callId: row.call_id,
    targetThreadId: row.target_thread_id,
    targetTurnId: row.target_turn_id ?? "",
    delivery: row.delivery,
    status: row.status,
  });
}

export interface ForwardedInteraction {
  readonly parentThreadId: string;
  readonly turn: TurnRow;
}

export function toUiSchedule(row: ScheduleRow): ui.Schedule {
  const ts = (date: Date | null | undefined) => (date ? timestampFromDate(new Date(date)) : undefined);
  const runAt = ts(row.run_at);
  const until = ts(row.until);
  const next = ts(row.next_run_at);
  const created = ts(row.created_at);

  return create(ui.ScheduleSchema, {
    id: row.id,
    threadId: row.thread_id ?? "",
    projectId: row.project_id ?? "",
    kind: row.kind,
    prompt: row.prompt,
    ...(runAt && { runAt }),
    cron: row.cron ?? "",
    timezone: row.timezone,
    ...(until && { until }),
    maxRuns: row.max_runs ?? 0,
    runs: row.runs,
    ...(next && { nextRunAt: next }),
    status: row.status,
    missedPolicy: row.missed_policy,
    createdBy: row.created_by_user_id ? "user" : "agent",
    createdByThreadId: row.created_by_thread_id ?? "",
    lastTurnId: row.last_turn_id ?? "",
    ...(created && { createdAt: created }),
    target: row.target,
    ...(row.new_thread && { newThread: fromJson(ui.NewThreadScheduleSchema, row.new_thread) }),
    concurrency: row.concurrency,
    name: row.name || row.prompt.slice(0, 60),
    configuredName: row.name,
    version: row.version,
    lastEditedByUserId: row.last_edited_by_user_id ?? "",
    ...(row.last_edited_at && { lastEditedAt: ts(row.last_edited_at) }),
    recentRuns: (row.recent_runs ?? []).map((r) => fromJson(ui.ScheduleRunSchema, r)),
  });
}

export function truncate(text: string, max: number, totalLength = text.length): string {
  return totalLength <= max ? text : `${text.slice(0, max)}… [${totalLength - max} more characters]`;
}

export function truncateJson(value: Record<string, JsonValue>): Record<string, JsonValue> {
  const entries = (object: Record<string, JsonValue>) =>
    Object.fromEntries(Object.entries(object).map(([k, x]) => [k, cut(x)]));

  const cut = (v: JsonValue): JsonValue =>
    Predicate.isString(v) ? truncate(v, 8_000) : Array.isArray(v) ? v.map(cut) : Predicate.isObject(v) ? entries(v) : v;

  return entries(value);
}

export function isUniqueViolation(error: SqlError.SqlError): boolean {
  for (let current: unknown = error, i = 0; i < 5 && Predicate.isObject(current); i++, current = current["cause"]) {
    if (current["code"] === "23505") return true;
  }

  return false;
}
