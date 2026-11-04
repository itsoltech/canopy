import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { selectScheduleWorkspace } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { GatewayStore, Invalid, NotFound, type ThreadRow, type TurnRow } from "./store.ts";

import {
  ScheduleConflict,
  inputJson,
  type CallSource,
  type FiredSchedule,
  type Fx,
  type NewSchedule,
  type ScheduleRow,
  type TurnInput,
} from "./agent-bus-types.ts";
import { insertCall, scheduleSelect, thread } from "./agent-bus-queries.ts";

export interface BusScheduleStore {
  /** An agent's schedule (schedule_wakeup / schedule_recurring), stored with its call. */
  createSchedule(input: { source: CallSource; tool: string; args: unknown; schedule: NewSchedule }): Fx<JsonValue>;
  /** Active and paused schedules of the caller and of the threads it spawned. */
  listSchedules(callerId: string): Fx<ReadonlyArray<ScheduleRow>>;
  cancelSchedule(scheduleId: string): Fx<void>;
  /** Schedules for the UI: of a thread, a project or all of the user's, with project and creator. */
  schedulesFor(input: {
    ownerUserId: string;
    projectId?: string;
    threadId?: string;
    includeFinished: boolean;
  }): Fx<ReadonlyArray<ScheduleRow>>;
  schedule(scheduleId: string): Fx<ScheduleRow>;
  /** A schedule the user creates in the UI: hops 0, may be open-ended. */
  createUserSchedule(input: { userId: string; schedule: NewSchedule }): Fx<ScheduleRow>;
  updateSchedule(input: {
    scheduleId: string;
    expectedVersion: number;
    userId: string;
    schedule: NewSchedule;
  }): Fx<ScheduleRow>;
  /** Pause (no next run), resume (with the next run) or cancel. */
  setScheduleStatus(input: {
    scheduleId: string;
    expectedVersion: number;
    status: "active" | "paused" | "cancelled";
    nextRunAt?: Date;
  }): Fx<ScheduleRow>;
  /** Leases due schedules for this gateway instance (safe with several instances). */
  claimDueSchedules(owner: string, now: Date, leaseSeconds: number): Fx<ReadonlyArray<ScheduleRow>>;
  /**
   * Records a run: queues the turn (unless skipped), counts it, sets the next run or completes the
   * schedule, releases the lease. A schedule of an archived thread is cancelled instead.
   */
  fireSchedule(input: {
    schedule: ScheduleRow;
    input: TurnInput;
    run: boolean;
    nextRunAt: Date | undefined;
    eligibleWorkerIds: readonly string[];
    now: Date;
    prepareWorkspace?: (
      request: ui.CreateThreadRequest,
      userId: string,
      sourceId: string,
    ) => Promise<ui.CreateThreadRequest>;
  }): Effect.Effect<FiredSchedule, SqlError.SqlError | NotFound | Invalid, GatewayStore>;
}

/** The thread a new_thread schedule starts this run in, created on its placement and sent to its worker. */
const scheduledThread = (
  sql: SqlClient.SqlClient,
  schedule: ScheduleRow,
  spec: ui.NewThreadSchedule,
  placement: { id: string; worker_id: string },
  prepareWorkspace: Parameters<BusScheduleStore["fireSchedule"]>[0]["prepareWorkspace"],
) =>
  Effect.gen(function* () {
    const gateway = yield* GatewayStore;

    const project = (yield* sql<{
      owner_user_id: string;
    }>`SELECT owner_user_id FROM projects WHERE id = ${schedule.project_id}::uuid`)[0]!;

    const request = create(ui.CreateThreadRequestSchema, {
      projectId: schedule.project_id!,
      workspaceId: placement.id,
      provider: spec.provider,
      providerProfileId: spec.providerProfileId,
      model: spec.model,
      effort: spec.effort,
      permissionMode: spec.permissionMode,
      title: spec.title,
      workspaceMode: spec.workspaceMode,
      baseRef: spec.baseRef,
      initialMessage: schedule.prompt,
    });

    const prepared = prepareWorkspace
      ? yield* Effect.tryPromise({
          try: () => prepareWorkspace(request, project.owner_user_id, spec.parentThreadId),
          catch: () => new Invalid("Could not prepare the scheduled workspace; it will retry when available"),
        })
      : request;

    let owner = yield* gateway.createThread(project.owner_user_id, { ...prepared, initialMessage: "" });

    yield* sql`UPDATE threads SET origin = 'schedule', schedule_id = ${schedule.id}::uuid,
          schedule_name = ${schedule.name || schedule.prompt.slice(0, 60)}, schedule_run = ${schedule.runs + 1},
          title = ${spec.title || schedule.prompt.split("\n")[0]!.slice(0, 60)} WHERE id = ${owner.id}::uuid`;
    owner = yield* gateway.thread(owner.id);

    const command = yield* gateway.enqueueCommand({
      workerId: placement.worker_id,
      threadId: owner.id,
      command: { kind: { case: "createThread", value: { thread: gateway.threadSpec(owner) } } },
      ttlSeconds: 365 * 24 * 3600,
    });

    return { thread: owner, command, newWorktree: prepared.workspaceMode === ui.WorkspaceMode.NEW_WORKTREE };
  });

export const fireSchedule = (
  sql: SqlClient.SqlClient,
  {
    schedule: claimed,
    input,
    run: shouldRun,
    nextRunAt,
    eligibleWorkerIds,
    now,
    prepareWorkspace,
  }: Parameters<BusScheduleStore["fireSchedule"]>[0],
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      // Fence stale leases and already handled occurrences, including ticks racing a pause or restart.
      const schedule = (yield* sql<ScheduleRow>`SELECT * FROM schedules WHERE id = ${claimed.id}::uuid FOR UPDATE`)[0];

      if (
        !schedule ||
        schedule.status !== "active" ||
        schedule.version !== claimed.version ||
        schedule.lease_owner !== claimed.lease_owner ||
        new Date(schedule.lease_until!).getTime() !== new Date(claimed.lease_until!).getTime() ||
        new Date(schedule.next_run_at!).getTime() !== new Date(claimed.next_run_at!).getTime()
      )
        return { threadId: "" };
      const occurrence = new Date(schedule.occurrence_at ?? schedule.next_run_at!);
      const spec = schedule.new_thread ? fromJson(ui.NewThreadScheduleSchema, schedule.new_thread) : undefined;
      let run = shouldRun;
      let outcome = run ? "started" : "missed";

      if (schedule.until && now > new Date(schedule.until)) {
        run = false;
        outcome = "expired";
        nextRunAt = undefined;
      }

      if (spec && run && schedule.concurrency === "skip_if_running") {
        const busy = yield* sql`SELECT 1 FROM schedule_runs sr WHERE sr.schedule_id = ${schedule.id}::uuid AND (
              EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = sr.thread_id AND u.status IN ('queued', 'running')) OR
              EXISTS (SELECT 1 FROM thread_items i WHERE i.thread_id = sr.thread_id AND i.type = 'background_task' AND i.status = 'in_progress')
            ) LIMIT 1`;

        if (busy.length) {
          run = false;
          outcome = "running";
        }
      }

      const candidates =
        spec && run
          ? yield* sql<{ id: string; worker_id: string; load: number }>`
            SELECT pw.id, pw.worker_id, (SELECT count(*)::int FROM turns u JOIN threads t ON t.id = u.thread_id
              WHERE t.worker_id = pw.worker_id AND u.status IN ('queued', 'running')) AS load
            FROM project_workspaces pw JOIN workers w ON w.id = pw.worker_id JOIN projects p ON p.id = pw.project_id
            WHERE pw.project_id = ${schedule.project_id}::uuid AND pw.archived_at IS NULL AND p.archived_at IS NULL
              AND w.archived_at IS NULL AND w.revoked_at IS NULL
              AND pw.worker_id = ANY(${[...eligibleWorkerIds]}::uuid[])
              AND (${spec.placement !== "specific"}::boolean OR pw.id = ${spec.workspaceId || null}::uuid)`
          : [];

      const placement = spec
        ? selectScheduleWorkspace(spec.placement, candidates, schedule.placement_cursor)
        : undefined;

      if (spec && run && !placement) {
        // Keep the occurrence key. The lease bounds retry frequency without changing its due time.
        yield* sql`UPDATE schedules SET lease_until = ${new Date(now.getTime() + 4_000)} WHERE id = ${schedule.id}::uuid`;

        return { threadId: "" };
      }

      let created: FiredSchedule["created"];
      let owner: ThreadRow | undefined;

      if (spec && run && placement) {
        created = yield* scheduledThread(sql, schedule, spec, placement, prepareWorkspace);
        owner = created.thread;
      } else if (!spec) owner = yield* thread(sql, schedule.thread_id!);

      if (owner && (owner.archived_at != null || owner.deleted_at != null)) {
        yield* sql`
              UPDATE schedules SET status = 'cancelled', next_run_at = NULL, lease_owner = NULL, lease_until = NULL, updated_at = now()
               WHERE id = ${schedule.id}::uuid`;

        return { threadId: owner.id };
      }

      if (owner) yield* sql`SELECT id FROM threads WHERE id = ${owner.id}::uuid FOR UPDATE`;

      const turn =
        run && owner
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
  );

const updateSchedule = (
  sql: SqlClient.SqlClient,
  store: Pick<BusScheduleStore, "schedule">,
  { scheduleId, expectedVersion, userId, schedule }: Parameters<BusScheduleStore["updateSchedule"]>[0],
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const current = (yield* sql<ScheduleRow>`SELECT s.* FROM schedules s JOIN projects p ON p.id = s.project_id
          WHERE s.id = ${scheduleId}::uuid AND p.owner_user_id = ${userId}::uuid FOR UPDATE OF s`)[0];

      if (!current) return yield* Effect.fail(new NotFound("schedule not found"));

      if (current.version !== expectedVersion)
        return yield* Effect.fail(
          new ScheduleConflict(
            "The schedule changed meanwhile. Close and reopen the editor to load its latest version.",
          ),
        );

      if (current.status !== "active" && current.status !== "paused")
        return yield* Effect.fail(new ScheduleConflict(`the schedule is already ${current.status}`));

      if (current.target === "thread" && !schedule.newThread && current.thread_id !== schedule.threadId) {
        return yield* Effect.fail(
          new Invalid("choose the original thread; moving to another existing thread is not supported"),
        );
      }

      if (schedule.maxRuns && schedule.maxRuns <= current.runs)
        return yield* Effect.fail(new Invalid("max_runs must exceed runs already completed"));

      if (!current.occurrence_at) {
        const handled =
          yield* sql`SELECT 1 FROM schedule_runs WHERE schedule_id = ${scheduleId}::uuid AND scheduled_for = ${schedule.nextRunAt}`;

        if (handled.length)
          return yield* Effect.fail(new Invalid("this occurrence has already been handled; choose a later run time"));
      }

      const projectId = schedule.newThread?.projectId ?? current.project_id;

      const project =
        yield* sql`SELECT id FROM projects WHERE id = ${projectId}::uuid AND owner_user_id = ${userId}::uuid AND archived_at IS NULL FOR SHARE`;

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
    }),
  );

export function busScheduleStore(sql: SqlClient.SqlClient): BusScheduleStore {
  const store: BusScheduleStore = {
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

          yield* insertCall(sql, { source, tool, args, status: "completed", result });
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
      sql
        .unsafe<ScheduleRow>(`${scheduleSelect} WHERE s.id = $1::uuid`, [scheduleId])
        .pipe(
          Effect.flatMap((rows) =>
            rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new NotFound("schedule not found")),
          ),
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

    updateSchedule: (input) => updateSchedule(sql, store, input),

    setScheduleStatus: ({ scheduleId, expectedVersion, status, nextRunAt }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT id FROM schedules WHERE id = ${scheduleId}::uuid FOR UPDATE`;
          const current = yield* store.schedule(scheduleId);

          if (current.status === "completed" || current.status === "cancelled") {
            return yield* Effect.fail(new Invalid(`the schedule is already ${current.status}`));
          }

          if (current.version !== expectedVersion)
            return yield* Effect.fail(new ScheduleConflict("the schedule changed meanwhile; try again"));
          yield* sql`
              UPDATE schedules SET status = ${status}, next_run_at = ${status === "active" ? (nextRunAt ?? null) : null},
                     lease_owner = NULL, lease_until = NULL, updated_at = now()
               WHERE id = ${scheduleId}::uuid`;

          return yield* store.schedule(scheduleId);
        }),
      ),

    claimDueSchedules: (owner, now, leaseSeconds) =>
      sql<ScheduleRow>`
            UPDATE schedules SET lease_owner = ${owner}, lease_until = ${new Date(now.getTime() + leaseSeconds * 1000)},
              occurrence_at = coalesce(occurrence_at, next_run_at)
             WHERE id IN (SELECT id FROM schedules
                           WHERE status = 'active' AND next_run_at <= ${now} AND (lease_until IS NULL OR lease_until < ${now})
                           ORDER BY next_run_at LIMIT 50 FOR UPDATE SKIP LOCKED)
            RETURNING *`,

    fireSchedule: (input) => fireSchedule(sql, input),
  };

  return store;
}
