import { create, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { CommandSchema, ui, type Command } from "@canopy/contracts";
import {
  agentKey,
  fuzzyRank,
  selectScheduleWorkspace,
  SPAWN_PERMISSION_MODES,
  type AgentBusArgs,
  type BusFacts,
  type InteractionFacts,
  type ScheduleFacts,
  type SpawnPermissionMode,
  type SpawnTarget,
  type ThreadNode,
} from "@canopy/domain";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { GatewayStore, Invalid, NotFound, type ThreadRow, type TurnRow } from "./store.ts";
import { questionStore, type QuestionStore } from "./questions.ts";
import { finishedTurn, observedSummaryTurns } from "./notification-observation.ts";

/**
 * Agent bus persistence (docs/agent-bus.md): the facts `authorizeBusCall` decides on, and the writes of
 * the calls it allows. Every call is idempotent by its id (= AgentToolCall.call_id): a call re-sent
 * after a reconnect finds its stored result instead of running again.
 */

export class ScheduleConflict extends Error {
  override readonly name = "ScheduleConflict";
}

type Fx<A> = Effect.Effect<A, SqlError.SqlError | NotFound | Invalid | ScheduleConflict>;

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
export function busPermissionMode(stored: string | undefined): SpawnPermissionMode {
  const mode = (stored ?? "ASK").toLowerCase();
  return (SPAWN_PERMISSION_MODES as readonly string[]).includes(mode) ? (mode as SpawnPermissionMode) : "ask";
}

export interface Notification {
  readonly call: BusCallRow;
  readonly target: ThreadRow;
  readonly turnStatus: string;
  readonly lastMessage: string;
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
  created?: { thread: ThreadRow; command: Command };
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
  return JSON.stringify({ text: input.message ? `${input.note}\n\n${input.message}` : input.note, note: input.note, message: input.message });
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

export class AgentBusStore extends Context.Service<
  AgentBusStore,
  {
    storedCall(callId: string): Fx<BusCallRow | undefined>;
    /** Loads the caller, the addressed threads and the counts `authorizeBusCall` needs. */
    facts(input: {
      source: CallSource;
      targetIds: readonly string[];
      /** spawn_thread: where the new thread runs (resolveSpawnTarget), for the fork rule. */
      spawnTarget?: SpawnTarget;
      interactionId?: string;
      scheduleId?: string;
      /** schedule_*: the thread whose active schedules count against the limit. */
      scheduleThreadId?: string;
    }): Fx<{ caller: ThreadRow; facts: BusFacts }>;
    /** A call that started nothing (reads, refusals, interrupts): stored with its result for idempotency. */
    recordCall(input: { source: CallSource; tool: string; args: unknown; ok: boolean; result?: JsonValue; error?: string; observedTurnIds?: readonly string[] }): Fx<void>;
    /** The caller explicitly stopped caring about a target, before interrupting it. */
    supersedeNotifications(callerId: string, targetId: string): Fx<void>;
    spawn(input: {
      source: CallSource;
      caller: ThreadRow;
      args: AgentBusArgs["spawn_thread"];
      /** Provider instance, model and effort of the new thread (resolveSpawnTarget). */
      target: SpawnTarget;
      hops: number;
    }): Fx<{ thread: ThreadRow; turn: TurnRow; result: JsonValue }>;
    /**
     * Queues the message as the next turn, or, with delivery = steer while the target runs a turn, stores it as a
     * steer of that turn (turn_steers; the caller hears back when the turn it joined finishes).
     */
    send(input: {
      source: CallSource;
      caller: ThreadRow;
      args: AgentBusArgs["send_message"];
      hops: number;
    }): Fx<{ turn: TurnRow; result: JsonValue; steerId?: undefined } | { turn?: undefined; steerId: string; result: JsonValue }>;
    summary(threadId: string): Fx<ThreadSummary>;
    /**
     * Threads of the caller's tree: its children, or the whole tree (without the caller); or (all) any thread of the
     * caller's owner, by title (fuzzy) when `query` is given, the most recent activity first.
     */
    listThreads(caller: ThreadRow, scope: "children" | "tree" | "all", options?: { query?: string; limit?: number }): Fx<ThreadSummary[]>;
    readThread(input: { threadId: string; afterSeq: number; limit: number; view: "messages" | "items" }): Fx<{ result: { entries: JsonValue[]; nextSeq: number }; observedTurnIds: string[] }>;
    /** The thread could not be created: its queued turns fail (so callers waiting on them hear back). */
    failQueuedTurns(threadId: string, reason: string): Fx<ReadonlyArray<string>>;
    /** Archives a thread, cancels its queued turns, its schedules and pending notifications about it. */
    close(threadId: string, callerId?: string): Fx<void>;
    /** An agent's schedule (schedule_wakeup / schedule_recurring), stored with its call. */
    createSchedule(input: { source: CallSource; tool: string; args: unknown; schedule: NewSchedule }): Fx<JsonValue>;
    /** Active and paused schedules of the caller and of the threads it spawned. */
    listSchedules(callerId: string): Fx<ReadonlyArray<ScheduleRow>>;
    cancelSchedule(scheduleId: string): Fx<void>;
    /** Schedules for the UI: of a thread, a project or all of the user's, with project and creator. */
    schedulesFor(input: { ownerUserId: string; projectId?: string; threadId?: string; includeFinished: boolean }): Fx<ReadonlyArray<ScheduleRow>>;
    schedule(scheduleId: string): Fx<ScheduleRow>;
    /** A schedule the user creates in the UI: hops 0, may be open-ended. */
    createUserSchedule(input: { userId: string; schedule: NewSchedule }): Fx<ScheduleRow>;
    updateSchedule(input: { scheduleId: string; expectedVersion: number; userId: string; schedule: NewSchedule }): Fx<ScheduleRow>;
    /** Pause (no next run), resume (with the next run) or cancel. */
    setScheduleStatus(input: { scheduleId: string; expectedVersion: number; status: "active" | "paused" | "cancelled"; nextRunAt?: Date }): Fx<ScheduleRow>;
    /** Leases due schedules for this gateway instance (safe with several instances). */
    claimDueSchedules(owner: string, now: Date, leaseSeconds: number): Fx<ReadonlyArray<ScheduleRow>>;
    /**
     * Records a run: queues the turn (unless skipped), counts it, sets the next run or completes the
     * schedule, releases the lease. A schedule of an archived thread is cancelled instead.
     */
    fireSchedule(input: { schedule: ScheduleRow; input: TurnInput; run: boolean; nextRunAt: Date | undefined; eligibleWorkerIds: readonly string[]; now: Date }): Effect.Effect<FiredSchedule, SqlError.SqlError | NotFound | Invalid, GatewayStore>;
    /** Pending interactions routed to the caller (from its side threads). */
    parentInteractions(callerId: string): Fx<ReadonlyArray<{ request_id: string; thread_id: string; kind: string; tool_name: string; request: JsonValue }>>;
    /**
     * Deliveries of spawn_thread / send_message calls: the latest of a calling thread (its snapshot), those that reached
     * a turn (its status changed) or the one behind an agent's steer.
     */
    deliveries(by: { sourceThreadId: string } | { turnId: string } | { steerId: string }): Fx<ReadonlyArray<DeliveryRow>>;
    /** Notifications due because `turnId` finished. */
    dueNotifications(turnId?: string): Fx<Notification[]>;
    /** A report whose steer failed or whose receiving turn ended without it. Restart reconciliation. */
    notificationFallbacks(): Fx<string[]>;
    /** Steers into the caller's running turn, otherwise queues an agent_bus turn. */
    deliverNotification(callId: string, input: TurnInput): Fx<{ turn?: TurnRow; steerId?: string } | undefined>;
    /**
     * A side thread with interaction_route = parent asks: queue a turn in the parent (trigger = interaction)
     * unless one exists already or the agent chain is too long (then the user answers in the UI).
     */
    forwardInteraction(input: { requestId: string; input: (thread: ThreadRow) => TurnInput; maxHops: number }): Fx<ForwardedInteraction | undefined>;
  } & QuestionStore
>()("canopy/gateway/AgentBusStore") {
  static readonly layer = Layer.effect(
    AgentBusStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const thread = (id: string) =>
        sql<ThreadRow>`SELECT t.*, (SELECT p.kind FROM projects p WHERE p.id = t.project_id) AS project_kind
          FROM threads t WHERE t.id = ${id}::uuid AND t.deleted_at IS NULL`.pipe(
          Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("thread not found")))),
        );
      const node = (row: ThreadRow & { archived_at?: Date | null }): ThreadNode => ({
        id: row.id,
        rootId: row.root_thread_id,
        depth: row.depth,
        ancestorIds: row.parent_thread_id ? [row.parent_thread_id, ...(row.root_thread_id !== row.parent_thread_id ? [row.root_thread_id] : [])] : [],
        ownerId: row.owner_user_id,
        provider: row.provider,
        instance: row.provider_profile_id || "native",
        archived: row.archived_at != null,
      });
      const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      const turnRef = (source: CallSource) =>
        sql`(SELECT id FROM turns WHERE id = ${isUuid(source.turnId) ? source.turnId : null}::uuid AND thread_id = ${source.threadId}::uuid)`;

      const lastMessage = (threadId: string, turnId?: string) =>
        sql<{ text: string | null }>`
          SELECT content->'agentMessage'->>'text' AS text FROM thread_items
           WHERE thread_id = ${threadId}::uuid AND type = 'agent_message'
             AND (${turnId ?? null}::uuid IS NULL OR turn_id = ${turnId ?? null}::uuid) ORDER BY first_seq DESC LIMIT 1`.pipe(
          Effect.map((rows) => rows[0]?.text ?? ""),
        );

      const summary = (threadId: string): Fx<ThreadSummary> =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            id: string; title: string; kind: "main" | "side"; parent_thread_id: string | null; status: string; provider: string;
            provider_profile_id: string | null; project: string | null; worker: string | null;
            settings: ThreadRow["settings"]; running: number; queued: number; for_parent: number; for_user: number;
          }>`
            SELECT t.id, t.title, t.kind, t.parent_thread_id, t.status, t.settings, t.provider, t.provider_profile_id,
                   (SELECT p.name FROM projects p WHERE p.id = t.project_id) AS project,
                   (SELECT w.name FROM workers w WHERE w.id = t.worker_id) AS worker,
                   (SELECT count(*)::int FROM turns u WHERE u.thread_id = t.id AND u.status = 'running') AS running,
                   (SELECT count(*)::int FROM turns u WHERE u.thread_id = t.id AND u.status = 'queued') AS queued,
                   (SELECT count(*)::int FROM interaction_requests i WHERE i.thread_id = t.id AND i.status = 'pending' AND i.routed_to = 'parent') AS for_parent,
                   (SELECT count(*)::int FROM interaction_requests i WHERE i.thread_id = t.id AND i.status = 'pending' AND i.routed_to = 'human') AS for_user
              FROM threads t WHERE t.id = ${threadId}::uuid AND t.deleted_at IS NULL`;
          const row = rows[0];
          if (!row) return yield* Effect.fail(new NotFound("thread not found"));
          const ended = (yield* sql<{ id: string; status: string; error: string | null; error_source: string | null; interrupt_reason: string | null; interrupt_source: string | null }>`
            SELECT id, status, error, error_source, interrupt_reason, interrupt_source FROM turns
             WHERE thread_id = ${row.id}::uuid AND status IN ('completed', 'interrupted', 'failed', 'cancelled') ORDER BY ordinal DESC LIMIT 1`)[0];
          const reason =
            ended?.status === "failed"
              ? [ended.error_source, ended.error].filter(Boolean).join(": ")
              : ended?.status === "interrupted"
                ? [ended.interrupt_source, ended.interrupt_reason].filter(Boolean).join(": ")
                : "";
          return {
            thread_id: row.id,
            title: row.title,
            kind: row.kind,
            parent_thread_id: row.parent_thread_id,
            status: row.status,
            provider: agentKey({ harness: row.provider === "claude" ? "claude" : row.provider === "grok" ? "grok" : "codex", instance: row.provider_profile_id ?? "" }),
            project: row.project ?? "",
            worker: row.worker ?? "",
            settled: row.running === 0 && row.queued === 0 && row.status !== "creating",
            queued_turns: row.queued,
            waiting_for_parent: row.for_parent,
            waiting_for_user: row.for_user,
            model: row.settings.model ?? "",
            effort: row.settings.effort ?? "",
            permission_mode: busPermissionMode(row.settings.permissionMode),
            ...(ended && { last_turn: { turn_id: ended.id, status: ended.status, ...(reason && { reason: truncate(reason, 1_000) }) } }),
            last_message: ended ? truncate(yield* lastMessage(row.id, ended.id), 4_000) : "",
          };
        });

      // The source thread lock serializes observation, notification delivery and queue dispatch.
      const consumeNotifications = (callerId: string, status: string, filter: { turnIds: readonly string[] } | { targetId: string }) =>
        Effect.gen(function* () {
          yield* sql`SELECT id FROM threads WHERE id = ${callerId}::uuid FOR UPDATE`;
          const calls = yield* sql<{ id: string; notified_turn_id: string | null }>`
            SELECT c.id, c.notified_turn_id FROM agent_bus_calls c
             WHERE c.source_thread_id = ${callerId}::uuid
               AND (${"targetId" in filter ? filter.targetId : null}::uuid IS NULL
                    OR c.target_thread_id = ${"targetId" in filter ? filter.targetId : null}::uuid)
               AND (${"turnIds" in filter ? `{${filter.turnIds.join(",")}}` : null}::uuid[] IS NULL
                    OR c.target_turn_id = ANY(${"turnIds" in filter ? `{${filter.turnIds.join(",")}}` : null}::uuid[]))
               AND (c.notify_status IN ('pending', 'steering') OR
                 (c.notify_status = 'delivered' AND EXISTS (
                   SELECT 1 FROM turns u WHERE u.id = c.notified_turn_id AND u.status = 'queued'
                     AND NOT EXISTS (SELECT 1 FROM worker_commands w WHERE w.turn_id = u.id AND w.status IN ('pending', 'delivered', 'completed')))))
             FOR UPDATE OF c`;
          for (const call of calls) {
            yield* sql`UPDATE agent_bus_calls SET notify_status = ${status} WHERE id = ${call.id}::uuid`;
            yield* sql`UPDATE turns SET status = 'cancelled', completed_at = now() WHERE id = ${call.notified_turn_id}::uuid AND status = 'queued'`;
            // An already dispatched input cannot be recalled. Suppress its fallback; a late acknowledgement
            // or transcript event must not resurrect it. Undispatched outbox commands are withdrawn too.
            yield* sql`UPDATE turn_steers SET status = 'failed', reason = ${status}, updated_at = now()
              WHERE notification_call_id = ${call.id}::uuid AND status IN ('pending', 'accepted', 'dropped')`;
            yield* sql`UPDATE worker_commands SET status = 'failed', completed_at = now()
              WHERE id IN (SELECT id FROM turn_steers WHERE notification_call_id = ${call.id}::uuid AND status = 'failed')
                AND status IN ('pending', 'delivered')`;
          }
        });

      const insertCall = (input: {
        source: CallSource;
        tool: string;
        args: unknown;
        status: "completed" | "failed";
        result?: JsonValue;
        error?: string;
        hops?: number;
        notify?: boolean;
      }) => sql`
        INSERT INTO agent_bus_calls (id, source_thread_id, source_turn_id, source_item_id, tool, arguments, status, result, error,
                                     hops, notify, notify_status, completed_at)
        VALUES (${input.source.callId}::uuid, ${input.source.threadId}::uuid, ${turnRef(input.source)}, ${input.source.itemId || null},
                ${input.tool}, ${JSON.stringify(input.args ?? {})}::jsonb, ${input.status},
                ${input.result === undefined ? null : JSON.stringify(input.result)}::jsonb, ${input.error ?? null},
                ${input.hops ?? null}, ${input.notify ?? false}, ${input.notify ? "pending" : null}, now())`;

      const queueTurn = (input: { threadId: string; input: TurnInput; trigger: "agent_bus" | "interaction"; callId?: string; interactionId?: string; hops: number }) =>
        sql<TurnRow>`
          INSERT INTO turns (id, thread_id, ordinal, trigger, agent_call_id, interaction_request_id, hops, input)
          SELECT ${Bun.randomUUIDv7()}::uuid, ${input.threadId}::uuid, coalesce(max(ordinal), 0) + 1, ${input.trigger},
                 ${input.callId ?? null}::uuid, ${input.interactionId ?? null}::uuid, ${input.hops}, ${inputJson(input.input)}::jsonb
            FROM turns WHERE thread_id = ${input.threadId}::uuid
          RETURNING *`.pipe(Effect.map((rows) => rows[0]!));

      const scheduleSelect = `
        SELECT s.*, p.owner_user_id, c.source_thread_id AS created_by_thread_id,
          (SELECT coalesce(jsonb_agg(r.data ORDER BY r.scheduled_for DESC), '[]'::jsonb) FROM
            (SELECT sr.scheduled_for, jsonb_build_object('scheduledFor', to_char(sr.scheduled_for AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'number', sr.number, 'threadId', coalesce(sr.thread_id::text, ''), 'turnId', coalesce(sr.turn_id::text, ''),
              'workerId', coalesce(sr.worker_id::text, ''), 'workspaceId', coalesce(sr.workspace_id::text, ''), 'outcome', sr.outcome,
              'createdAt', to_char(sr.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS data
             FROM schedule_runs sr WHERE sr.schedule_id = s.id ORDER BY sr.scheduled_for DESC LIMIT 5) r) AS recent_runs
          FROM schedules s JOIN projects p ON p.id = s.project_id LEFT JOIN threads t ON t.id = s.thread_id
          LEFT JOIN agent_bus_calls c ON c.id = s.created_by_call_id`;

      /**
       * The caller's effective permission mode: the mode its calling turn runs with (a message may override the
       * thread's default for one turn), else its running turn's, else the thread's default. The ceiling of
       * spawn_thread and the mode a subagent gets when it asks for none.
       */
      const callerMode = (source: CallSource, caller: ThreadRow) =>
        sql<{ permission_mode: string }>`
          SELECT permission_mode FROM turns
           WHERE permission_mode <> '' AND (id = ${turnRef(source)} OR (thread_id = ${caller.id}::uuid AND status = 'running'))
           ORDER BY (id = ${turnRef(source)}) DESC NULLS LAST LIMIT 1`.pipe(
          Effect.map((rows) => busPermissionMode(rows[0]?.permission_mode || caller.settings.permissionMode)),
        );

      const store: AgentBusStore["Service"] = {
        ...questionStore(sql),
        storedCall: (callId) =>
          isUuid(callId)
            ? sql<BusCallRow>`SELECT * FROM agent_bus_calls WHERE id = ${callId}::uuid`.pipe(Effect.map((rows) => rows[0]))
            : Effect.succeed(undefined),

        facts: ({ source, targetIds, spawnTarget, interactionId, scheduleId, scheduleThreadId }) =>
          Effect.gen(function* () {
            const caller = yield* thread(source.threadId);
            const hopsRows = yield* sql<{ hops: number }>`SELECT hops FROM turns WHERE id = ${turnRef(source)}`;
            const targets = new Map<string, ThreadNode>();
            for (const id of new Set(targetIds)) {
              if (!isUuid(id)) continue;
              const rows = yield* sql<ThreadRow>`SELECT * FROM threads WHERE id = ${id}::uuid AND deleted_at IS NULL`;
              if (rows[0]) targets.set(id, node(rows[0]));
            }
            const counts = yield* sql<{ children: number; active: number }>`
              SELECT (SELECT count(*)::int FROM threads c WHERE c.parent_thread_id = ${caller.id}::uuid AND c.archived_at IS NULL AND c.deleted_at IS NULL) AS children,
                     (SELECT count(*)::int FROM threads t WHERE t.root_thread_id = ${caller.root_thread_id}::uuid AND t.archived_at IS NULL AND t.deleted_at IS NULL
                         AND (t.status IN ('creating', 'running', 'waiting_input')
                              OR EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.status = 'queued'))) AS active`;
            let interaction: InteractionFacts | undefined;
            if (interactionId && isUuid(interactionId)) {
              const rows = yield* sql<{ id: string; thread_id: string; kind: InteractionFacts["kind"]; routed_to: InteractionFacts["routedTo"]; status: string }>`
                SELECT id, thread_id, kind, routed_to, status FROM interaction_requests WHERE id = ${interactionId}::uuid`;
              const row = rows[0];
              if (row) {
                interaction = { id: row.id, threadId: row.thread_id, kind: row.kind, routedTo: row.routed_to, status: row.status };
                const owner = yield* sql<ThreadRow>`SELECT * FROM threads WHERE id = ${row.thread_id}::uuid`;
                if (owner[0]) targets.set(row.thread_id, node(owner[0]));
              }
            }
            let schedule: ScheduleFacts | undefined;
            if (scheduleId && isUuid(scheduleId)) {
              const rows = yield* sql<{ id: string; thread_id: string }>`
                SELECT id, thread_id FROM schedules WHERE id = ${scheduleId}::uuid AND status IN ('active', 'paused')`;
              if (rows[0]) {
                schedule = { id: rows[0].id, threadId: rows[0].thread_id };
                const owner = yield* sql<ThreadRow>`SELECT * FROM threads WHERE id = ${rows[0].thread_id}::uuid`;
                if (owner[0]) targets.set(owner[0].id, node(owner[0]));
              }
            }
            const scheduleCount =
              scheduleThreadId && isUuid(scheduleThreadId)
                ? (yield* sql<{ n: number }>`
                    SELECT count(*)::int AS n FROM schedules WHERE thread_id = ${scheduleThreadId}::uuid AND status IN ('active', 'paused')`)[0]?.n
                : undefined;
            const facts: BusFacts = {
              caller: node(caller),
              callerHops: hopsRows[0]?.hops ?? 0,
              targets,
              callerChildren: counts[0]?.children ?? 0,
              activeInTree: counts[0]?.active ?? 0,
              callerPermissionMode: yield* callerMode(source, caller),
              ...(spawnTarget && { spawnProvider: spawnTarget.harness, spawnInstance: spawnTarget.instance || "native" }),
              ...(interaction && { interaction }),
              ...(schedule && { schedule }),
              ...(scheduleCount !== undefined && { targetSchedules: scheduleCount }),
              now: new Date(),
            };
            return { caller, facts };
          }),

        recordCall: ({ source, tool, args, ok, result, error, observedTurnIds }) =>
          sql.withTransaction(Effect.gen(function* () {
            const observed = observedTurnIds ?? observedSummaryTurns(tool, result);
            if (ok && observed.length > 0) yield* consumeNotifications(source.threadId, tool === "wait_threads" ? "consumed_by_wait" : "consumed_by_read", { turnIds: observed });
            yield* insertCall({
              source,
              tool,
              args,
              status: ok ? "completed" : "failed",
              ...(result !== undefined && { result }),
              ...(error !== undefined && { error }),
            });
          })).pipe(
            // A concurrent duplicate stored it first: same call, same outcome.
            Effect.catchTag("SqlError", (e) => (isUniqueViolation(e) ? Effect.void : Effect.fail(e))),
            Effect.asVoid,
          ),

        supersedeNotifications: (callerId, targetId) => sql.withTransaction(consumeNotifications(callerId, "superseded", { targetId })),

        spawn: ({ source, caller, args, target, hops }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const notify = args.notify ?? true;
              yield* insertCall({ source, tool: "spawn_thread", args, status: "completed", hops, notify });
              const id = Bun.randomUUIDv7();
              // Same place as the caller (threads_before_insert enforces the placement), on the provider instance, model
              // and effort the gateway resolved (the caller's unless the call chose others from list_agents); its
              // permissions unless the call narrows them (authorizeBusCall: never broader). A role adds to the caller's
              // instructions.
              const settings: ThreadRow["settings"] = {
                ...caller.settings,
                // The calling turn's mode, not the thread's default (never broader than the caller right now).
                permissionMode: (yield* callerMode(source, caller)).toUpperCase(),
                model: target.model,
                effort: target.effort,
                ...(args.permission_mode !== undefined && { permissionMode: args.permission_mode.toUpperCase() }),
                ...(args.instructions !== undefined && {
                  instructions: [caller.settings.instructions, args.instructions].filter(Boolean).join("\n\n"),
                }),
              };
              yield* sql`
                INSERT INTO threads (id, project_id, owner_user_id, kind, parent_thread_id, root_thread_id, depth, origin, spawned_by_call_id,
                                     interaction_route, runtime, provider, provider_profile_id, worker_id, workspace_id, cwd,
                                     fork_source_thread_id, settings, status, title)
                VALUES (${id}::uuid, ${caller.project_id}::uuid, ${caller.owner_user_id}::uuid, 'side', ${caller.id}::uuid,
                        ${caller.root_thread_id}::uuid, ${caller.depth + 1}, 'agent', ${source.callId}::uuid,
                        ${args.interactions ?? "parent"}, 'worker', ${target.harness},
                        ${target.instance && target.instance !== "native" ? target.instance : null},
                        ${caller.worker_id}::uuid, ${caller.workspace_id}::uuid, ${caller.cwd},
                        ${args.fork ? caller.id : null}::uuid, ${JSON.stringify(settings)}::jsonb, 'creating', ${args.title.trim()})`;
              const input: TurnInput = {
                note:
                  `[canopy] Task from the thread "${caller.title}" (thread_id: ${caller.id}). ` +
                  "End your turn with a final message that reports your result; it is delivered to that thread.",
                message: args.prompt,
              };
              const turn = yield* queueTurn({ threadId: id, input, trigger: "agent_bus", callId: source.callId, hops });
              // Stored as returned: a re-sent call gets exactly this.
              const result = {
                thread_id: id,
                turn_id: turn.id,
                provider: agentKey(target),
                model: settings.model ?? "",
                effort: settings.effort ?? "",
                permission_mode: busPermissionMode(settings.permissionMode),
                note: notify
                  ? "The side thread is working. You will get a message in this thread when it finishes its turn; continue meanwhile or call wait_threads."
                  : "The side thread is working. Follow it with wait_threads or get_thread.",
              };
              yield* sql`
                UPDATE agent_bus_calls SET target_thread_id = ${id}::uuid, target_turn_id = ${turn.id}::uuid, result = ${JSON.stringify(result)}::jsonb
                 WHERE id = ${source.callId}::uuid`;
              return { thread: yield* thread(id), turn, result };
            }),
          ),

        send: ({ source, caller, args, hops }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const notify = args.notify ?? true;
              yield* insertCall({ source, tool: "send_message", args, status: "completed", hops, notify });
              // From another tree (any thread of the same owner, like the user writing there): the target learns who wrote.
              const target = yield* thread(args.thread_id);
              const outside = target.root_thread_id !== caller.root_thread_id;
              const input: TurnInput = {
                note:
                  `[canopy] Message from the thread "${caller.title}" (thread_id: ${caller.id})` +
                  (outside ? `, an agent outside your thread tree${notify ? "; your final message of this turn is reported back to it" : ""}` : "") +
                  ":",
                message: args.prompt,
              };
              const running =
                args.delivery === "steer"
                  ? (yield* sql<{ id: string }>`SELECT id FROM turns WHERE thread_id = ${args.thread_id}::uuid AND status = 'running' LIMIT 1`)[0]
                  : undefined;
              if (running) {
                // The call reports the turn once the message is in it (Ingest binds target_turn_id), or the turn it
                // falls back to.
                const steerId = Bun.randomUUIDv7();
                yield* sql`
                  INSERT INTO turn_steers (id, thread_id, turn_id, input, agent_call_id, hops)
                  VALUES (${steerId}::uuid, ${args.thread_id}::uuid, ${running.id}::uuid, ${inputJson(input)}::jsonb, ${source.callId}::uuid, ${hops})`;
                const result = {
                  thread_id: args.thread_id,
                  turn_id: running.id,
                  delivery: "steer",
                  note: "The message joins the turn that is running now. If that turn ends first, it runs as the next turn instead.",
                };
                yield* sql`
                  UPDATE agent_bus_calls SET target_thread_id = ${args.thread_id}::uuid, result = ${JSON.stringify(result)}::jsonb
                   WHERE id = ${source.callId}::uuid`;
                return { steerId, result };
              }
              const turn = yield* queueTurn({ threadId: args.thread_id, input, trigger: "agent_bus", callId: source.callId, hops });
              const result = {
                thread_id: args.thread_id,
                turn_id: turn.id,
                ...(args.delivery === "steer" && { delivery: "queue", note: "No turn is running there: the message runs as the next turn." }),
              };
              yield* sql`
                UPDATE agent_bus_calls SET target_thread_id = ${args.thread_id}::uuid, target_turn_id = ${turn.id}::uuid, result = ${JSON.stringify(result)}::jsonb
                 WHERE id = ${source.callId}::uuid`;
              return { turn, result };
            }),
          ),

        summary,

        listThreads: (caller, scope, options) =>
          Effect.gen(function* () {
            if (scope === "all") {
              const owned = yield* sql<{ id: string; title: string }>`
                SELECT t.id, t.title FROM threads t
                 WHERE t.owner_user_id = ${caller.owner_user_id}::uuid AND t.id <> ${caller.id}::uuid AND t.archived_at IS NULL AND t.deleted_at IS NULL
                 ORDER BY greatest(t.created_at, (SELECT max(coalesce(u.completed_at, u.started_at, u.queued_at)) FROM turns u WHERE u.thread_id = t.id)) DESC
                 LIMIT 500`;
              const limit = options?.limit ?? 20;
              const query = options?.query?.trim() ?? "";
              const picked = query ? fuzzyRank(query, owned, (t) => [t.title || "Untitled"], limit).map((r) => r.item) : owned.slice(0, limit);
              return yield* Effect.forEach(picked, (r) => summary(r.id));
            }
            const rows =
              scope === "children"
                ? yield* sql<{ id: string }>`SELECT id FROM threads WHERE parent_thread_id = ${caller.id}::uuid AND archived_at IS NULL AND deleted_at IS NULL ORDER BY created_at`
                : yield* sql<{ id: string }>`
                    SELECT id FROM threads WHERE root_thread_id = ${caller.root_thread_id}::uuid AND id <> ${caller.id}::uuid AND archived_at IS NULL AND deleted_at IS NULL
                     ORDER BY depth, created_at`;
            return yield* Effect.forEach(rows, (r) => summary(r.id));
          }),

        readThread: ({ threadId, afterSeq, limit, view }) =>
          Effect.gen(function* () {
            const rows = yield* sql<{ type: string; content: Record<string, JsonValue>; last_seq: bigint; turn_id: string | null; turn_status: string | null; final: boolean }>`
              SELECT i.type, i.content, i.last_seq, i.turn_id, u.status AS turn_status,
                     i.type = 'agent_message' AND NOT EXISTS (
                       SELECT 1 FROM thread_items later WHERE later.thread_id = i.thread_id AND later.turn_id = i.turn_id
                         AND later.type = 'agent_message' AND later.first_seq > i.first_seq) AS final
                FROM thread_items i LEFT JOIN turns u ON u.id = i.turn_id
               WHERE i.thread_id = ${threadId}::uuid AND i.last_seq > ${afterSeq}
                 AND (${view} = 'items' OR i.type IN ('user_message', 'agent_message'))
               ORDER BY i.first_seq LIMIT ${limit}`;
            const entries = rows.map((r): JsonValue => {
              const { itemId: _id, status: _status, ...content } = r.content;
              return { seq: Number(r.last_seq), type: r.type, ...truncateJson(content) };
            });
            return {
              result: { entries, nextSeq: rows.length > 0 ? Number(rows[rows.length - 1]!.last_seq) : afterSeq },
              observedTurnIds: rows.flatMap((r) => r.final && r.turn_id && finishedTurn(r.turn_status ?? "") ? [r.turn_id] : []),
            };
          }),

        failQueuedTurns: (threadId, reason) =>
          sql<{ id: string }>`
            UPDATE turns SET status = 'failed', error = ${reason}, error_source = 'platform', completed_at = now()
             WHERE thread_id = ${threadId}::uuid AND status = 'queued' RETURNING id`.pipe(Effect.map((rows) => rows.map((r) => r.id))),

        close: (threadId, callerId) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE threads SET status = 'archived', archived_at = now(), archived_by = 'agent', archived_by_thread_id = ${callerId ?? null}::uuid
                WHERE id = ${threadId}::uuid AND archived_at IS NULL AND deleted_at IS NULL`;
              yield* sql`UPDATE turns SET status = 'cancelled', completed_at = now() WHERE thread_id = ${threadId}::uuid AND status = 'queued'`;
              yield* sql`UPDATE agent_bus_calls SET notify_status = 'cancelled' WHERE target_thread_id = ${threadId}::uuid AND notify_status = 'pending'`;
              yield* sql`
                UPDATE schedules SET status = 'cancelled', next_run_at = NULL, lease_owner = NULL, lease_until = NULL, updated_at = now()
                 WHERE thread_id = ${threadId}::uuid AND status IN ('active', 'paused')`;
            }),
          ),

        createSchedule: ({ source, tool, args, schedule }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const id = Bun.randomUUIDv7();
              const result = {
                schedule_id: id,
                thread_id: schedule.threadId,
                next_run_at: schedule.nextRunAt.toISOString(),
                ...(schedule.kind === "recurring" && { cron: schedule.cron, timezone: schedule.timezone }),
              };
              yield* insertCall({ source, tool, args, status: "completed", result });
              yield* sql`
                INSERT INTO schedules (id, thread_id, project_id, kind, prompt, run_at, cron, timezone, until, max_runs, next_run_at, created_by_call_id, hops)
                VALUES (${id}::uuid, ${schedule.threadId}::uuid, (SELECT project_id FROM threads WHERE id = ${schedule.threadId}::uuid), ${schedule.kind}, ${schedule.prompt}, ${schedule.runAt ?? null},
                        ${schedule.cron ?? null}, ${schedule.timezone}, ${schedule.until ?? null}, ${schedule.maxRuns ?? null},
                        ${schedule.nextRunAt}, ${source.callId}::uuid, ${schedule.hops})`;
              return result;
            }),
          ),

        listSchedules: (callerId) =>
          sql<ScheduleRow>`
            SELECT s.* FROM schedules s JOIN threads t ON t.id = s.thread_id
             WHERE (t.id = ${callerId}::uuid OR t.parent_thread_id = ${callerId}::uuid) AND s.status IN ('active', 'paused')
             ORDER BY s.next_run_at NULLS LAST`,

        cancelSchedule: (scheduleId) =>
          sql`
            UPDATE schedules SET status = 'cancelled', next_run_at = NULL, lease_owner = NULL, lease_until = NULL, updated_at = now()
             WHERE id = ${scheduleId}::uuid AND status IN ('active', 'paused')`.pipe(Effect.asVoid),

        schedulesFor: ({ ownerUserId, projectId, threadId, includeFinished }) =>
          sql.unsafe<ScheduleRow>(
            `${scheduleSelect}
              WHERE p.owner_user_id = $1::uuid AND (s.thread_id IS NULL OR t.deleted_at IS NULL)
                AND ($2::uuid IS NULL OR s.project_id = $2::uuid)
                AND ($3::uuid IS NULL OR s.thread_id = $3::uuid)
                AND ($4::boolean OR s.status IN ('active', 'paused'))
              ORDER BY s.next_run_at NULLS LAST, s.created_at`,
            [ownerUserId, projectId || null, threadId || null, includeFinished],
          ),

        schedule: (scheduleId) =>
          sql.unsafe<ScheduleRow>(`${scheduleSelect} WHERE s.id = $1::uuid`, [scheduleId]).pipe(
            Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("schedule not found")))),
          ),

        createUserSchedule: ({ userId, schedule }) =>
          Effect.gen(function* () {
            const id = Bun.randomUUIDv7();
            yield* sql`
              INSERT INTO schedules (id, thread_id, project_id, target, new_thread, concurrency, name, kind, prompt, run_at, cron, timezone, until, max_runs, next_run_at, missed_policy, created_by_user_id, hops)
              VALUES (${id}::uuid, ${schedule.threadId || null}::uuid,
                      coalesce(${schedule.newThread?.projectId ?? null}::uuid, (SELECT project_id FROM threads WHERE id = ${schedule.threadId || null}::uuid)),
                      ${schedule.newThread ? "new_thread" : "thread"}, ${schedule.newThread ? JSON.stringify(toJson(ui.NewThreadScheduleSchema, schedule.newThread)) : null}::jsonb,
                      ${schedule.concurrency ?? "skip_if_running"}, ${schedule.name ?? ""}, ${schedule.kind}, ${schedule.prompt}, ${schedule.runAt ?? null},
                      ${schedule.cron ?? null}, ${schedule.timezone}, ${schedule.until ?? null}, ${schedule.maxRuns ?? null},
                      ${schedule.nextRunAt}, ${schedule.missedPolicy ?? "run_once"}, ${userId}::uuid, 0)`;
            return yield* store.schedule(id);
          }),

        updateSchedule: ({ scheduleId, expectedVersion, userId, schedule }) =>
          sql.withTransaction(Effect.gen(function* () {
            const current = (yield* sql<ScheduleRow>`SELECT s.* FROM schedules s JOIN projects p ON p.id = s.project_id
              WHERE s.id = ${scheduleId}::uuid AND p.owner_user_id = ${userId}::uuid FOR UPDATE OF s`)[0];
            if (!current) return yield* Effect.fail(new NotFound("schedule not found"));
            if (current.version !== expectedVersion) return yield* Effect.fail(new ScheduleConflict("The schedule changed meanwhile. Close and reopen the editor to load its latest version."));
            if (current.status !== "active" && current.status !== "paused") return yield* Effect.fail(new ScheduleConflict(`the schedule is already ${current.status}`));
            if (current.target === "thread" && !schedule.newThread && current.thread_id !== schedule.threadId) {
              return yield* Effect.fail(new Invalid("choose the original thread; moving to another existing thread is not supported"));
            }
            if (schedule.maxRuns && schedule.maxRuns <= current.runs) return yield* Effect.fail(new Invalid("max_runs must exceed runs already completed"));
            if (!current.occurrence_at) {
              const handled = yield* sql`SELECT 1 FROM schedule_runs WHERE schedule_id = ${scheduleId}::uuid AND scheduled_for = ${schedule.nextRunAt}`;
              if (handled.length) return yield* Effect.fail(new Invalid("this occurrence has already been handled; choose a later run time"));
            }
            const projectId = schedule.newThread?.projectId ?? current.project_id;
            const project = yield* sql`SELECT id FROM projects WHERE id = ${projectId}::uuid AND owner_user_id = ${userId}::uuid AND archived_at IS NULL FOR SHARE`;
            if (!project.length) return yield* Effect.fail(new Invalid("project not found"));
            yield* sql`UPDATE schedules SET thread_id = ${schedule.threadId || null}::uuid,
              project_id = coalesce(${schedule.newThread?.projectId ?? null}::uuid, (SELECT project_id FROM threads WHERE id = ${schedule.threadId || null}::uuid)),
              target = ${schedule.newThread ? "new_thread" : "thread"},
              new_thread = ${schedule.newThread ? JSON.stringify(toJson(ui.NewThreadScheduleSchema, schedule.newThread)) : null}::jsonb,
              concurrency = ${schedule.concurrency ?? "skip_if_running"}, name = ${schedule.name ?? ""},
              kind = ${schedule.kind}, prompt = ${schedule.prompt}, run_at = ${schedule.runAt ?? null}, cron = ${schedule.cron ?? null},
              timezone = ${schedule.timezone}, until = ${schedule.until ?? null}, max_runs = ${schedule.maxRuns ?? null},
              next_run_at = ${current.status === "active" ? schedule.nextRunAt : null}, missed_policy = ${schedule.missedPolicy ?? "run_once"},
              last_edited_by_user_id = ${userId}::uuid, last_edited_at = clock_timestamp(),
              placement_cursor = CASE WHEN project_id = ${projectId}::uuid THEN placement_cursor ELSE NULL END,
              lease_owner = NULL, lease_until = NULL, updated_at = now()
              WHERE id = ${scheduleId}::uuid`;
            return yield* store.schedule(scheduleId);
          })),

        setScheduleStatus: ({ scheduleId, expectedVersion, status, nextRunAt }) =>
          sql.withTransaction(Effect.gen(function* () {
            yield* sql`SELECT id FROM schedules WHERE id = ${scheduleId}::uuid FOR UPDATE`;
            const current = yield* store.schedule(scheduleId);
            if (current.status === "completed" || current.status === "cancelled") {
              return yield* Effect.fail(new Invalid(`the schedule is already ${current.status}`));
            }
            if (current.version !== expectedVersion) return yield* Effect.fail(new ScheduleConflict("the schedule changed meanwhile; try again"));
            yield* sql`
              UPDATE schedules SET status = ${status}, next_run_at = ${status === "active" ? (nextRunAt ?? null) : null},
                     lease_owner = NULL, lease_until = NULL, updated_at = now()
               WHERE id = ${scheduleId}::uuid`;
            return yield* store.schedule(scheduleId);
          })),

        claimDueSchedules: (owner, now, leaseSeconds) =>
          sql<ScheduleRow>`
            UPDATE schedules SET lease_owner = ${owner}, lease_until = ${new Date(now.getTime() + leaseSeconds * 1000)},
              occurrence_at = coalesce(occurrence_at, next_run_at)
             WHERE id IN (SELECT id FROM schedules
                           WHERE status = 'active' AND next_run_at <= ${now} AND (lease_until IS NULL OR lease_until < ${now})
                           ORDER BY next_run_at LIMIT 50 FOR UPDATE SKIP LOCKED)
            RETURNING *`,

        fireSchedule: ({ schedule: claimed, input, run: shouldRun, nextRunAt, eligibleWorkerIds, now }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              // Fence stale leases and already handled occurrences, including ticks racing a pause or restart.
              const schedule = (yield* sql<ScheduleRow>`SELECT * FROM schedules WHERE id = ${claimed.id}::uuid FOR UPDATE`)[0];
              if (!schedule || schedule.status !== 'active' || schedule.version !== claimed.version || schedule.lease_owner !== claimed.lease_owner ||
                  new Date(schedule.lease_until!).getTime() !== new Date(claimed.lease_until!).getTime() ||
                  new Date(schedule.next_run_at!).getTime() !== new Date(claimed.next_run_at!).getTime()) return { threadId: "" };
              const occurrence = new Date(schedule.occurrence_at ?? schedule.next_run_at!);
              const spec = schedule.new_thread ? fromJson(ui.NewThreadScheduleSchema, schedule.new_thread) : undefined;
              let run = shouldRun;
              let outcome = run ? "started" : "missed";
              if (schedule.until && now > new Date(schedule.until)) { run = false; outcome = "expired"; nextRunAt = undefined; }
              if (spec && run && schedule.concurrency === "skip_if_running") {
                const busy = yield* sql`SELECT 1 FROM schedule_runs sr WHERE sr.schedule_id = ${schedule.id}::uuid AND (
                  EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = sr.thread_id AND u.status IN ('queued', 'running')) OR
                  EXISTS (SELECT 1 FROM thread_items i WHERE i.thread_id = sr.thread_id AND i.type = 'background_task' AND i.status = 'in_progress')
                ) LIMIT 1`;
                if (busy.length) { run = false; outcome = "running"; }
              }
              const candidates = spec && run ? yield* sql<{ id: string; worker_id: string; load: number }>`
                SELECT pw.id, pw.worker_id, (SELECT count(*)::int FROM turns u JOIN threads t ON t.id = u.thread_id
                  WHERE t.worker_id = pw.worker_id AND u.status IN ('queued', 'running')) AS load
                FROM project_workspaces pw JOIN workers w ON w.id = pw.worker_id JOIN projects p ON p.id = pw.project_id
                WHERE pw.project_id = ${schedule.project_id}::uuid AND pw.archived_at IS NULL AND p.archived_at IS NULL
                  AND w.archived_at IS NULL AND w.revoked_at IS NULL
                  AND pw.worker_id = ANY(${[...eligibleWorkerIds]}::uuid[])
                  AND (${spec.placement !== "specific"}::boolean OR pw.id = ${spec.workspaceId || null}::uuid)` : [];
              const placement = spec ? selectScheduleWorkspace(spec.placement, candidates, schedule.placement_cursor) : undefined;
              if (spec && run && !placement) {
                // Keep the occurrence key. The lease bounds retry frequency without changing its due time.
                yield* sql`UPDATE schedules SET lease_until = ${new Date(now.getTime() + 4_000)} WHERE id = ${schedule.id}::uuid`;
                return { threadId: "" };
              }
              let created: FiredSchedule["created"];
              let owner: ThreadRow | undefined;
              if (spec && run && placement) {
                const gateway = yield* GatewayStore;
                const project = (yield* sql<{ owner_user_id: string }>`SELECT owner_user_id FROM projects WHERE id = ${schedule.project_id}::uuid`)[0]!;
                owner = yield* gateway.createThread(project.owner_user_id, create(ui.CreateThreadRequestSchema, {
                  projectId: schedule.project_id!, workspaceId: placement.id, provider: spec.provider, providerProfileId: spec.providerProfileId,
                  model: spec.model, effort: spec.effort, permissionMode: spec.permissionMode, title: spec.title,
                }));
                yield* sql`UPDATE threads SET origin = 'schedule', schedule_id = ${schedule.id}::uuid,
                  schedule_name = ${schedule.name || schedule.prompt.slice(0, 60)}, schedule_run = ${schedule.runs + 1},
                  title = ${spec.title || schedule.prompt.split("\n")[0]!.slice(0, 60)} WHERE id = ${owner.id}::uuid`;
                owner = yield* gateway.thread(owner.id);
                const command = yield* gateway.enqueueCommand({ workerId: placement.worker_id, threadId: owner.id,
                  command: { kind: { case: "createThread", value: { thread: gateway.threadSpec(owner) } } }, ttlSeconds: 365 * 24 * 3600 });
                created = { thread: owner, command };
              } else if (!spec) owner = yield* thread(schedule.thread_id!);
              if (owner && (owner.archived_at != null || owner.deleted_at != null)) {
                yield* sql`
                  UPDATE schedules SET status = 'cancelled', next_run_at = NULL, lease_owner = NULL, lease_until = NULL, updated_at = now()
                   WHERE id = ${schedule.id}::uuid`;
                return { threadId: owner.id };
              }
              if (owner) yield* sql`SELECT id FROM threads WHERE id = ${owner.id}::uuid FOR UPDATE`;
              const turn = run && owner
                ? yield* sql<TurnRow>`
                    INSERT INTO turns (id, thread_id, ordinal, trigger, schedule_id, hops, input)
                    SELECT ${Bun.randomUUIDv7()}::uuid, ${owner.id}::uuid, coalesce(max(ordinal), 0) + 1, 'schedule', ${schedule.id}::uuid,
                           ${spec ? 0 : schedule.hops}, ${inputJson(input)}::jsonb
                      FROM turns WHERE thread_id = ${owner.id}::uuid
                    RETURNING *`.pipe(Effect.map((rows) => rows[0]))
                : undefined;
              yield* sql`INSERT INTO schedule_runs (schedule_id, scheduled_for, number, thread_id, turn_id, worker_id, workspace_id, outcome)
                VALUES (${schedule.id}::uuid, ${occurrence}, ${turn ? schedule.runs + 1 : 0}, ${turn ? owner!.id : null}::uuid,
                  ${turn?.id ?? null}::uuid, ${turn ? owner!.worker_id : null}::uuid, ${turn ? owner!.workspace_id : null}::uuid, ${outcome})`;
              const runs = schedule.runs + (turn ? 1 : 0);
              const finished =
                nextRunAt === undefined ||
                (schedule.max_runs !== null && runs >= schedule.max_runs) ||
                (schedule.until !== null && nextRunAt.getTime() > new Date(schedule.until).getTime());
              yield* sql`
                UPDATE schedules SET runs = ${runs}, last_turn_id = coalesce(${turn?.id ?? null}::uuid, last_turn_id),
                       placement_cursor = coalesce(${placement?.id ?? null}::uuid, placement_cursor),
                       next_run_at = ${finished ? null : nextRunAt}, status = ${finished ? "completed" : "active"},
                       lease_owner = NULL, lease_until = NULL, occurrence_at = NULL, updated_at = now()
                 WHERE id = ${schedule.id}::uuid`;
              return { threadId: owner?.id ?? "", ...(turn && { turn }), ...(created && { created }) };
            }),
          ),

        parentInteractions: (callerId) =>
          sql<{ request_id: string; thread_id: string; kind: string; tool_name: string; request: JsonValue }>`
            SELECT i.id AS request_id, i.thread_id, i.kind, i.tool_name, i.request FROM interaction_requests i
              JOIN threads t ON t.id = i.thread_id
             WHERE t.parent_thread_id = ${callerId}::uuid AND i.status = 'pending' AND i.routed_to = 'parent'
             ORDER BY i.created_at`,

        deliveries: (by) => {
          // A steer that fell back is a queued message; one on its way has no turn of its own yet.
          const select = `
            SELECT c.id AS call_id, c.source_thread_id, c.target_thread_id, coalesce(c.target_turn_id, st.queued_turn_id) AS target_turn_id,
                   CASE WHEN st.id IS NOT NULL AND st.status <> 'queued' THEN 'steer' ELSE 'queue' END AS delivery,
                   coalesce(CASE WHEN st.status IN ('pending', 'accepted', 'dropped') THEN 'steering' WHEN st.status = 'failed' THEN 'failed' END,
                            u.status, 'queued') AS status
              FROM agent_bus_calls c
              LEFT JOIN turn_steers st ON st.agent_call_id = c.id
              LEFT JOIN turns u ON u.id = coalesce(c.target_turn_id, st.queued_turn_id)
             WHERE c.tool IN ('spawn_thread', 'send_message') AND c.status = 'completed' AND c.target_thread_id IS NOT NULL`;
          return "sourceThreadId" in by
            ? sql.unsafe<DeliveryRow>(`${select} AND c.source_thread_id = $1::uuid ORDER BY c.created_at DESC LIMIT 200`, [by.sourceThreadId])
            : "turnId" in by
              ? sql.unsafe<DeliveryRow>(`${select} AND (c.target_turn_id = $1::uuid OR st.queued_turn_id = $1::uuid)`, [by.turnId])
              : sql.unsafe<DeliveryRow>(`${select} AND st.id = $1::uuid`, [by.steerId]);
        },

        dueNotifications: (turnId) =>
          Effect.gen(function* () {
            const calls = yield* sql<BusCallRow & { turn_status: string }>`
              SELECT c.*, u.status AS turn_status FROM agent_bus_calls c JOIN turns u ON u.id = c.target_turn_id
               WHERE (${turnId ?? null}::uuid IS NULL OR c.target_turn_id = ${turnId ?? null}::uuid) AND c.notify_status = 'pending'
                 AND u.status IN ('completed', 'interrupted', 'failed', 'cancelled')`;
            return yield* Effect.forEach(calls, (call) =>
              Effect.gen(function* () {
                const target = yield* thread(call.target_thread_id ?? "");
                return { call, target, turnStatus: call.turn_status, lastMessage: yield* lastMessage(target.id, call.target_turn_id!) };
              }),
            );
          }),

        notificationFallbacks: () => sql<{ id: string }>`
          SELECT s.id FROM turn_steers s JOIN agent_bus_calls c ON c.id = s.notification_call_id
            JOIN turns u ON u.id = s.turn_id LEFT JOIN worker_commands w ON w.id = s.id
           WHERE c.notify_status = 'steering' AND s.status IN ('pending', 'accepted', 'dropped')
             AND (s.status = 'dropped' OR u.status IN ('completed', 'interrupted', 'failed', 'cancelled')
                  OR w.status = 'failed' OR (w.status IN ('pending', 'delivered') AND w.expires_at <= now()))`
          .pipe(Effect.map((rows) => rows.map((r) => r.id))),

        deliverNotification: (callId, input) =>
          sql.withTransaction(
            Effect.gen(function* () {
              // Same lock order as consumption and QueueStore.whileHead.
              const sources = yield* sql<ThreadRow>`SELECT t.* FROM threads t JOIN agent_bus_calls c ON c.source_thread_id = t.id
                WHERE c.id = ${callId}::uuid FOR UPDATE OF t`;
              const rows = yield* sql<BusCallRow>`
                SELECT c.* FROM agent_bus_calls c
                 WHERE c.id = ${callId}::uuid AND c.notify_status = 'pending' FOR UPDATE OF c`;
              const call = rows[0];
              if (!call) return undefined; // delivered meanwhile
              const caller = sources[0];
              if (!caller || caller.archived_at || caller.deleted_at) {
                yield* sql`UPDATE agent_bus_calls SET notify_status = 'cancelled' WHERE id = ${callId}::uuid`;
                return undefined;
              }
              const hops = Math.min((call.hops ?? 0) + 1, 16);
              const running = (yield* sql<{ id: string }>`SELECT id FROM turns WHERE thread_id = ${call.source_thread_id}::uuid AND status = 'running' LIMIT 1`)[0];
              if (running && caller.worker_id) {
                const steerId = Bun.randomUUIDv7();
                yield* sql`INSERT INTO turn_steers(id, thread_id, turn_id, input, notification_call_id, hops)
                  VALUES (${steerId}::uuid, ${caller.id}::uuid, ${running.id}::uuid, ${inputJson(input)}::jsonb, ${callId}::uuid, ${hops})`;
                const command = create(CommandSchema, { commandId: steerId, kind: { case: "steerTurn", value: {
                  threadId: caller.id, turnId: running.id, inputId: steerId,
                  input: { text: input.message ? `${input.note}\n\n${input.message}` : input.note, authorAgentId: call.target_thread_id! },
                } } });
                yield* sql`INSERT INTO worker_commands(id, worker_id, thread_id, kind, payload, expires_at)
                  VALUES (${steerId}::uuid, ${caller.worker_id}::uuid, ${caller.id}::uuid, 'steerTurn', ${toBinary(CommandSchema, command)}, now() + interval '24 hours')`;
                yield* sql`UPDATE agent_bus_calls SET notify_status = 'steering', notified_steer_id = ${steerId}::uuid WHERE id = ${callId}::uuid`;
                return { steerId };
              }
              const turn = yield* queueTurn({
                threadId: call.source_thread_id,
                input,
                trigger: "agent_bus",
                callId,
                hops,
              });
              yield* sql`UPDATE agent_bus_calls SET notify_status = 'delivered', notified_turn_id = ${turn.id}::uuid WHERE id = ${callId}::uuid`;
              return { turn };
            }),
          ),

        forwardInteraction: ({ requestId, input, maxHops }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<{ thread_id: string; hops: number | null; status: string; routed_to: string; forwarded: boolean }>`
                SELECT i.thread_id, u.hops, i.status, i.routed_to,
                       EXISTS (SELECT 1 FROM turns f WHERE f.interaction_request_id = i.id) AS forwarded
                  FROM interaction_requests i LEFT JOIN turns u ON u.id = i.turn_id
                 WHERE i.id = ${requestId}::uuid FOR UPDATE OF i`;
              const row = rows[0];
              if (!row || row.routed_to !== "parent" || row.status !== "pending" || row.forwarded) return undefined;
              const asking = yield* thread(row.thread_id);
              if (!asking.parent_thread_id) return undefined;
              const hops = (row.hops ?? 0) + 1;
              if (hops > maxHops) return undefined; // agent chain too long: the user answers in the UI
              const turn = yield* queueTurn({ threadId: asking.parent_thread_id, input: input(asking), trigger: "interaction", interactionId: requestId, hops });
              return { parentThreadId: asking.parent_thread_id, turn };
            }),
          ),
      };
      return AgentBusStore.of(store);
    }),
  );
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

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`;
}

/** Long strings inside an item (command output, diffs) are cut so a read stays small. */
function truncateJson(value: Record<string, JsonValue>): Record<string, JsonValue> {
  const cut = (v: JsonValue): JsonValue =>
    typeof v === "string" ? truncate(v, 8_000) : Array.isArray(v) ? v.map(cut) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)])) : v;
  return cut(value) as Record<string, JsonValue>;
}

export function isUniqueViolation(error: SqlError.SqlError): boolean {
  for (let current: unknown = error, i = 0; i < 5 && current && typeof current === "object"; i++, current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: unknown }).code === "23505") return true;
  }
  return false;
}
