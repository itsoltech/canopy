import { create, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@open-agents/contracts";
import type { AgentBusArgs, BusFacts, InteractionFacts, ScheduleFacts, ThreadNode } from "@open-agents/domain";
import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { Invalid, NotFound, type ThreadRow, type TurnRow } from "./store.ts";

/**
 * Agent bus persistence (docs/agent-bus.md): the facts `authorizeBusCall` decides on, and the writes of
 * the calls it allows. Every call is idempotent by its id (= AgentToolCall.call_id): a call re-sent
 * after a reconnect finds its stored result instead of running again.
 */

type Fx<A> = Effect.Effect<A, SqlError.SqlError | NotFound | Invalid>;

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
  /** Settled = nothing running or queued: the thread waits for new input. */
  readonly settled: boolean;
  readonly queued_turns: number;
  /** Questions and permission prompts of this thread waiting for its parent agent. */
  readonly waiting_for_parent: number;
  readonly waiting_for_user: number;
  readonly last_message: string;
}

export interface Notification {
  readonly call: BusCallRow;
  readonly target: ThreadRow;
  readonly turnStatus: string;
  readonly lastMessage: string;
}

export interface ScheduleRow {
  id: string;
  thread_id: string;
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
  /** Joined: the thread's project and, for agent schedules, the calling thread. */
  project_id?: string;
  created_by_thread_id?: string | null;
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
      interactionId?: string;
      scheduleId?: string;
      /** schedule_*: the thread whose active schedules count against the limit. */
      scheduleThreadId?: string;
    }): Fx<{ caller: ThreadRow; facts: BusFacts }>;
    /** A call that started nothing (reads, refusals, interrupts): stored with its result for idempotency. */
    recordCall(input: { source: CallSource; tool: string; args: unknown; ok: boolean; result?: JsonValue; error?: string }): Fx<void>;
    spawn(input: {
      source: CallSource;
      caller: ThreadRow;
      args: AgentBusArgs["spawn_thread"];
      hops: number;
    }): Fx<{ thread: ThreadRow; turn: TurnRow; result: JsonValue }>;
    send(input: { source: CallSource; caller: ThreadRow; args: AgentBusArgs["send_message"]; hops: number }): Fx<{ turn: TurnRow; result: JsonValue }>;
    summary(threadId: string): Fx<ThreadSummary>;
    /** Threads of the caller's tree: its children, or the whole tree (without the caller). */
    listThreads(caller: ThreadRow, scope: "children" | "tree"): Fx<ThreadSummary[]>;
    readThread(input: { threadId: string; afterSeq: number; limit: number; view: "messages" | "items" }): Fx<{ entries: JsonValue[]; nextSeq: number }>;
    /** The thread could not be created: its queued turns fail (so callers waiting on them hear back). */
    failQueuedTurns(threadId: string, reason: string): Fx<ReadonlyArray<string>>;
    /** Archives a thread, cancels its queued turns, its schedules and pending notifications about it. */
    close(threadId: string): Fx<void>;
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
    /** Pause (no next run), resume (with the next run) or cancel. */
    setScheduleStatus(input: { scheduleId: string; status: "active" | "paused" | "cancelled"; nextRunAt?: Date }): Fx<ScheduleRow>;
    /** Leases due schedules for this gateway instance (safe with several instances). */
    claimDueSchedules(owner: string, now: Date, leaseSeconds: number): Fx<ReadonlyArray<ScheduleRow>>;
    /**
     * Records a run: queues the turn (unless skipped), counts it, sets the next run or completes the
     * schedule, releases the lease. A schedule of an archived thread is cancelled instead.
     */
    fireSchedule(input: { schedule: ScheduleRow; text: string; run: boolean; nextRunAt: Date | undefined }): Fx<{ threadId: string; turn?: TurnRow }>;
    /** Pending interactions routed to the caller (from its side threads). */
    parentInteractions(callerId: string): Fx<ReadonlyArray<{ request_id: string; thread_id: string; kind: string; tool_name: string; request: JsonValue }>>;
    /** Notifications due because `turnId` finished. */
    dueNotifications(turnId: string): Fx<Notification[]>;
    /** Queues the notification turn in the calling thread (or cancels it when that thread is gone). */
    deliverNotification(callId: string, text: string): Fx<TurnRow | undefined>;
    /**
     * A side thread with interaction_route = parent asks: queue a turn in the parent (trigger = interaction)
     * unless one exists already or the agent chain is too long (then the user answers in the UI).
     */
    forwardInteraction(input: { requestId: string; text: (thread: ThreadRow) => string; maxHops: number }): Fx<ForwardedInteraction | undefined>;
  }
>()("open-agents/gateway/AgentBusStore") {
  static readonly layer = Layer.effect(
    AgentBusStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const thread = (id: string) =>
        sql<ThreadRow>`SELECT * FROM threads WHERE id = ${id}::uuid`.pipe(
          Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("thread not found")))),
        );
      const node = (row: ThreadRow & { archived_at?: Date | null }): ThreadNode => ({
        id: row.id,
        rootId: row.root_thread_id,
        depth: row.depth,
        ancestorIds: row.parent_thread_id ? [row.parent_thread_id, ...(row.root_thread_id !== row.parent_thread_id ? [row.root_thread_id] : [])] : [],
        provider: row.provider,
        archived: row.archived_at != null,
      });
      const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      const turnRef = (source: CallSource) =>
        sql`(SELECT id FROM turns WHERE id = ${isUuid(source.turnId) ? source.turnId : null}::uuid AND thread_id = ${source.threadId}::uuid)`;

      const lastMessage = (threadId: string) =>
        sql<{ text: string | null }>`
          SELECT content->'agentMessage'->>'text' AS text FROM thread_items
           WHERE thread_id = ${threadId}::uuid AND type = 'agent_message' ORDER BY first_seq DESC LIMIT 1`.pipe(
          Effect.map((rows) => rows[0]?.text ?? ""),
        );

      const summary = (threadId: string): Fx<ThreadSummary> =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            id: string; title: string; kind: "main" | "side"; parent_thread_id: string | null; status: string;
            running: number; queued: number; for_parent: number; for_user: number;
          }>`
            SELECT t.id, t.title, t.kind, t.parent_thread_id, t.status,
                   (SELECT count(*)::int FROM turns u WHERE u.thread_id = t.id AND u.status = 'running') AS running,
                   (SELECT count(*)::int FROM turns u WHERE u.thread_id = t.id AND u.status = 'queued') AS queued,
                   (SELECT count(*)::int FROM interaction_requests i WHERE i.thread_id = t.id AND i.status = 'pending' AND i.routed_to = 'parent') AS for_parent,
                   (SELECT count(*)::int FROM interaction_requests i WHERE i.thread_id = t.id AND i.status = 'pending' AND i.routed_to = 'human') AS for_user
              FROM threads t WHERE t.id = ${threadId}::uuid`;
          const row = rows[0];
          if (!row) return yield* Effect.fail(new NotFound("thread not found"));
          return {
            thread_id: row.id,
            title: row.title,
            kind: row.kind,
            parent_thread_id: row.parent_thread_id,
            status: row.status,
            settled: row.running === 0 && row.queued === 0 && row.status !== "creating",
            queued_turns: row.queued,
            waiting_for_parent: row.for_parent,
            waiting_for_user: row.for_user,
            last_message: truncate(yield* lastMessage(row.id), 4_000),
          };
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

      const queueTurn = (input: { threadId: string; text: string; trigger: "agent_bus" | "interaction"; callId?: string; interactionId?: string; hops: number }) =>
        sql<TurnRow>`
          INSERT INTO turns (id, thread_id, ordinal, trigger, agent_call_id, interaction_request_id, hops, input)
          SELECT ${Bun.randomUUIDv7()}::uuid, ${input.threadId}::uuid, coalesce(max(ordinal), 0) + 1, ${input.trigger},
                 ${input.callId ?? null}::uuid, ${input.interactionId ?? null}::uuid, ${input.hops}, ${JSON.stringify({ text: input.text })}::jsonb
            FROM turns WHERE thread_id = ${input.threadId}::uuid
          RETURNING *`.pipe(Effect.map((rows) => rows[0]!));

      const scheduleSelect = `
        SELECT s.*, t.project_id, c.source_thread_id AS created_by_thread_id
          FROM schedules s JOIN threads t ON t.id = s.thread_id LEFT JOIN agent_bus_calls c ON c.id = s.created_by_call_id`;

      const store: AgentBusStore["Service"] = {
        storedCall: (callId) =>
          isUuid(callId)
            ? sql<BusCallRow>`SELECT * FROM agent_bus_calls WHERE id = ${callId}::uuid`.pipe(Effect.map((rows) => rows[0]))
            : Effect.succeed(undefined),

        facts: ({ source, targetIds, interactionId, scheduleId, scheduleThreadId }) =>
          Effect.gen(function* () {
            const caller = yield* thread(source.threadId);
            const hopsRows = yield* sql<{ hops: number }>`SELECT hops FROM turns WHERE id = ${turnRef(source)}`;
            const targets = new Map<string, ThreadNode>();
            for (const id of new Set(targetIds)) {
              if (!isUuid(id)) continue;
              const rows = yield* sql<ThreadRow>`SELECT * FROM threads WHERE id = ${id}::uuid`;
              if (rows[0]) targets.set(id, node(rows[0]));
            }
            const counts = yield* sql<{ children: number; active: number }>`
              SELECT (SELECT count(*)::int FROM threads c WHERE c.parent_thread_id = ${caller.id}::uuid AND c.archived_at IS NULL) AS children,
                     (SELECT count(*)::int FROM threads t WHERE t.root_thread_id = ${caller.root_thread_id}::uuid AND t.archived_at IS NULL
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
              spawnProvider: caller.provider,
              ...(interaction && { interaction }),
              ...(schedule && { schedule }),
              ...(scheduleCount !== undefined && { targetSchedules: scheduleCount }),
              now: new Date(),
            };
            return { caller, facts };
          }),

        recordCall: ({ source, tool, args, ok, result, error }) =>
          insertCall({
            source,
            tool,
            args,
            status: ok ? "completed" : "failed",
            ...(result !== undefined && { result }),
            ...(error !== undefined && { error }),
          }).pipe(
            // A concurrent duplicate stored it first: same call, same outcome.
            Effect.catchTag("SqlError", (e) => (isUniqueViolation(e) ? Effect.void : Effect.fail(e))),
            Effect.asVoid,
          ),

        spawn: ({ source, caller, args, hops }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const notify = args.notify ?? true;
              yield* insertCall({ source, tool: "spawn_thread", args, status: "completed", hops, notify });
              const id = Bun.randomUUIDv7();
              // Same place, provider and settings as the caller (threads_before_insert enforces the placement).
              yield* sql`
                INSERT INTO threads (id, project_id, owner_user_id, kind, parent_thread_id, root_thread_id, depth, origin, spawned_by_call_id,
                                     interaction_route, runtime, provider, provider_profile_id, worker_id, workspace_id, cwd,
                                     fork_source_thread_id, settings, status, title)
                VALUES (${id}::uuid, ${caller.project_id}::uuid, ${caller.owner_user_id}::uuid, 'side', ${caller.id}::uuid,
                        ${caller.root_thread_id}::uuid, ${caller.depth + 1}, 'agent', ${source.callId}::uuid,
                        ${args.interactions ?? "parent"}, 'worker', ${caller.provider}, ${caller.provider_profile_id},
                        ${caller.worker_id}::uuid, ${caller.workspace_id}::uuid, ${caller.cwd},
                        ${args.fork ? caller.id : null}::uuid, ${JSON.stringify(caller.settings)}::jsonb, 'creating', ${args.title.trim()})`;
              const prompt =
                `[open-agents] Task from the thread "${caller.title}" (thread_id: ${caller.id}). ` +
                `End your turn with a final message that reports your result; it is delivered to that thread.\n\n${args.prompt}`;
              const turn = yield* queueTurn({ threadId: id, text: prompt, trigger: "agent_bus", callId: source.callId, hops });
              // Stored as returned: a re-sent call gets exactly this.
              const result = {
                thread_id: id,
                turn_id: turn.id,
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
              const text = `[open-agents] Message from the thread "${caller.title}" (thread_id: ${caller.id}):\n\n${args.prompt}`;
              const turn = yield* queueTurn({ threadId: args.thread_id, text, trigger: "agent_bus", callId: source.callId, hops });
              const result = {
                thread_id: args.thread_id,
                turn_id: turn.id,
                ...(args.delivery === "steer" && { note: "steer is not available yet: the message was queued as the next turn" }),
              };
              yield* sql`
                UPDATE agent_bus_calls SET target_thread_id = ${args.thread_id}::uuid, target_turn_id = ${turn.id}::uuid, result = ${JSON.stringify(result)}::jsonb
                 WHERE id = ${source.callId}::uuid`;
              return { turn, result };
            }),
          ),

        summary,

        listThreads: (caller, scope) =>
          Effect.gen(function* () {
            const rows =
              scope === "children"
                ? yield* sql<{ id: string }>`SELECT id FROM threads WHERE parent_thread_id = ${caller.id}::uuid AND archived_at IS NULL ORDER BY created_at`
                : yield* sql<{ id: string }>`
                    SELECT id FROM threads WHERE root_thread_id = ${caller.root_thread_id}::uuid AND id <> ${caller.id}::uuid AND archived_at IS NULL
                     ORDER BY depth, created_at`;
            return yield* Effect.forEach(rows, (r) => summary(r.id));
          }),

        readThread: ({ threadId, afterSeq, limit, view }) =>
          Effect.gen(function* () {
            const rows = yield* sql<{ type: string; content: Record<string, JsonValue>; last_seq: bigint }>`
              SELECT type, content, last_seq FROM thread_items
               WHERE thread_id = ${threadId}::uuid AND last_seq > ${afterSeq}
                 AND (${view} = 'items' OR type IN ('user_message', 'agent_message'))
               ORDER BY first_seq LIMIT ${limit}`;
            const entries = rows.map((r): JsonValue => {
              const { itemId: _id, status: _status, ...content } = r.content;
              return { seq: Number(r.last_seq), type: r.type, ...truncateJson(content) };
            });
            return { entries, nextSeq: rows.length > 0 ? Number(rows[rows.length - 1]!.last_seq) : afterSeq };
          }),

        failQueuedTurns: (threadId, reason) =>
          sql<{ id: string }>`
            UPDATE turns SET status = 'failed', error = ${reason}, completed_at = now()
             WHERE thread_id = ${threadId}::uuid AND status = 'queued' RETURNING id`.pipe(Effect.map((rows) => rows.map((r) => r.id))),

        close: (threadId) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE threads SET status = 'archived', archived_at = now() WHERE id = ${threadId}::uuid AND archived_at IS NULL`;
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
                INSERT INTO schedules (id, thread_id, kind, prompt, run_at, cron, timezone, until, max_runs, next_run_at, created_by_call_id, hops)
                VALUES (${id}::uuid, ${schedule.threadId}::uuid, ${schedule.kind}, ${schedule.prompt}, ${schedule.runAt ?? null},
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
              WHERE t.owner_user_id = $1::uuid
                AND ($2::uuid IS NULL OR t.project_id = $2::uuid)
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
              INSERT INTO schedules (id, thread_id, kind, prompt, run_at, cron, timezone, until, max_runs, next_run_at, missed_policy, created_by_user_id, hops)
              VALUES (${id}::uuid, ${schedule.threadId}::uuid, ${schedule.kind}, ${schedule.prompt}, ${schedule.runAt ?? null},
                      ${schedule.cron ?? null}, ${schedule.timezone}, ${schedule.until ?? null}, ${schedule.maxRuns ?? null},
                      ${schedule.nextRunAt}, ${schedule.missedPolicy ?? "run_once"}, ${userId}::uuid, 0)`;
            return yield* store.schedule(id);
          }),

        setScheduleStatus: ({ scheduleId, status, nextRunAt }) =>
          Effect.gen(function* () {
            const current = yield* store.schedule(scheduleId);
            if (current.status === "completed" || current.status === "cancelled") {
              return yield* Effect.fail(new Invalid(`the schedule is already ${current.status}`));
            }
            yield* sql`
              UPDATE schedules SET status = ${status}, next_run_at = ${status === "active" ? (nextRunAt ?? null) : null},
                     lease_owner = NULL, lease_until = NULL, updated_at = now()
               WHERE id = ${scheduleId}::uuid`;
            return yield* store.schedule(scheduleId);
          }),

        claimDueSchedules: (owner, now, leaseSeconds) =>
          sql<ScheduleRow>`
            UPDATE schedules SET lease_owner = ${owner}, lease_until = ${new Date(now.getTime() + leaseSeconds * 1000)}
             WHERE id IN (SELECT id FROM schedules
                           WHERE status = 'active' AND next_run_at <= ${now} AND (lease_until IS NULL OR lease_until < ${now})
                           ORDER BY next_run_at LIMIT 50 FOR UPDATE SKIP LOCKED)
            RETURNING *`,

        fireSchedule: ({ schedule, text, run, nextRunAt }) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const owner = yield* thread(schedule.thread_id);
              if (owner.archived_at != null) {
                yield* sql`
                  UPDATE schedules SET status = 'cancelled', next_run_at = NULL, lease_owner = NULL, lease_until = NULL, updated_at = now()
                   WHERE id = ${schedule.id}::uuid`;
                return { threadId: owner.id };
              }
              const turn = run
                ? yield* sql<TurnRow>`
                    INSERT INTO turns (id, thread_id, ordinal, trigger, schedule_id, hops, input)
                    SELECT ${Bun.randomUUIDv7()}::uuid, ${owner.id}::uuid, coalesce(max(ordinal), 0) + 1, 'schedule', ${schedule.id}::uuid,
                           ${schedule.hops}, ${JSON.stringify({ text })}::jsonb
                      FROM turns WHERE thread_id = ${owner.id}::uuid
                    RETURNING *`.pipe(Effect.map((rows) => rows[0]))
                : undefined;
              const runs = schedule.runs + (run ? 1 : 0);
              const finished =
                nextRunAt === undefined ||
                (schedule.max_runs !== null && runs >= schedule.max_runs) ||
                (schedule.until !== null && nextRunAt.getTime() > new Date(schedule.until).getTime());
              yield* sql`
                UPDATE schedules SET runs = ${runs}, last_turn_id = coalesce(${turn?.id ?? null}::uuid, last_turn_id),
                       next_run_at = ${finished ? null : nextRunAt}, status = ${finished ? "completed" : "active"},
                       lease_owner = NULL, lease_until = NULL, updated_at = now()
                 WHERE id = ${schedule.id}::uuid`;
              return { threadId: owner.id, ...(turn && { turn }) };
            }),
          ),

        parentInteractions: (callerId) =>
          sql<{ request_id: string; thread_id: string; kind: string; tool_name: string; request: JsonValue }>`
            SELECT i.id AS request_id, i.thread_id, i.kind, i.tool_name, i.request FROM interaction_requests i
              JOIN threads t ON t.id = i.thread_id
             WHERE t.parent_thread_id = ${callerId}::uuid AND i.status = 'pending' AND i.routed_to = 'parent'
             ORDER BY i.created_at`,

        dueNotifications: (turnId) =>
          Effect.gen(function* () {
            const calls = yield* sql<BusCallRow & { turn_status: string }>`
              SELECT c.*, u.status AS turn_status FROM agent_bus_calls c JOIN turns u ON u.id = c.target_turn_id
               WHERE c.target_turn_id = ${turnId}::uuid AND c.notify_status = 'pending'
                 AND u.status IN ('completed', 'interrupted', 'failed', 'cancelled')`;
            return yield* Effect.forEach(calls, (call) =>
              Effect.gen(function* () {
                const target = yield* thread(call.target_thread_id ?? "");
                return { call, target, turnStatus: call.turn_status, lastMessage: yield* lastMessage(target.id) };
              }),
            );
          }),

        deliverNotification: (callId, text) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<BusCallRow & { source_archived: boolean }>`
                SELECT c.*, t.archived_at IS NOT NULL AS source_archived FROM agent_bus_calls c JOIN threads t ON t.id = c.source_thread_id
                 WHERE c.id = ${callId}::uuid AND c.notify_status = 'pending' FOR UPDATE OF c`;
              const call = rows[0];
              if (!call) return undefined; // delivered meanwhile
              if (call.source_archived) {
                yield* sql`UPDATE agent_bus_calls SET notify_status = 'cancelled' WHERE id = ${callId}::uuid`;
                return undefined;
              }
              const turn = yield* queueTurn({
                threadId: call.source_thread_id,
                text,
                trigger: "agent_bus",
                callId,
                hops: Math.min((call.hops ?? 0) + 1, 16),
              });
              yield* sql`UPDATE agent_bus_calls SET notify_status = 'delivered', notified_turn_id = ${turn.id}::uuid WHERE id = ${callId}::uuid`;
              return turn;
            }),
          ),

        forwardInteraction: ({ requestId, text, maxHops }) =>
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
              const turn = yield* queueTurn({ threadId: asking.parent_thread_id, text: text(asking), trigger: "interaction", interactionId: requestId, hops });
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
    threadId: row.thread_id,
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
