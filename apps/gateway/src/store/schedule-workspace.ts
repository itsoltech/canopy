import { create, fromJson } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { selectScheduleWorkspace } from "@canopy/domain";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { BusScheduleStore } from "./bus-schedules.ts";
import { GatewayStore, Invalid } from "./store.ts";
import type { ScheduleRow } from "./agent-bus-types.ts";

export interface PreparedSchedule {
  readonly request: ui.CreateThreadRequest;
  readonly ownerId: string;
  readonly placement: { readonly id: string; readonly worker_id: string };
}

export const scheduleBusy = (sql: SqlClient.SqlClient, id: string) => sql`
  SELECT 1 FROM schedule_runs sr WHERE sr.schedule_id = ${id}::uuid AND (
    EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = sr.thread_id AND u.status IN ('queued', 'running')) OR
    EXISTS (SELECT 1 FROM thread_items i WHERE i.thread_id = sr.thread_id AND i.type = 'background_task' AND i.status = 'in_progress')
  ) LIMIT 1`;

/** All external workspace I/O happens before acquiring the schedule row lock or a transaction connection. */
export const prepareSchedule = (sql: SqlClient.SqlClient, input: Parameters<BusScheduleStore["fireSchedule"]>[0]) =>
  Effect.gen(function* () {
    const { schedule, eligibleWorkerIds, now } = input;

    if (!schedule.new_thread || !input.run || (schedule.until && now > new Date(schedule.until))) return;

    if (schedule.concurrency === "skip_if_running" && (yield* scheduleBusy(sql, schedule.id)).length) return;
    const spec = fromJson(ui.NewThreadScheduleSchema, schedule.new_thread);

    const candidates = yield* sql<{ id: string; worker_id: string; owner_user_id: string; load: number }>`
      SELECT pw.id, pw.worker_id, p.owner_user_id,
        (SELECT count(*)::int FROM turns u JOIN threads t ON t.id=u.thread_id
         WHERE t.worker_id=pw.worker_id AND u.status IN ('queued','running')) AS load
      FROM project_workspaces pw JOIN workers w ON w.id=pw.worker_id JOIN projects p ON p.id=pw.project_id
      JOIN schedules s ON s.project_id=p.id
      WHERE s.id=${schedule.id}::uuid AND s.status='active' AND s.version=${schedule.version}
        AND s.lease_owner=${schedule.lease_owner} AND s.lease_until=${schedule.lease_until}
        AND s.next_run_at=${schedule.next_run_at} AND pw.archived_at IS NULL AND p.archived_at IS NULL
        AND w.archived_at IS NULL AND w.revoked_at IS NULL AND pw.worker_id=ANY(${[...eligibleWorkerIds]}::uuid[])
        AND (${spec.placement !== "specific"}::boolean OR pw.id=${spec.workspaceId || null}::uuid)`;

    const placement = selectScheduleWorkspace(spec.placement, candidates, schedule.placement_cursor);

    if (!placement) return;
    const ownerId = candidates.find((candidate) => candidate.id === placement.id)!.owner_user_id;

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

    const prepared = input.prepareWorkspace
      ? yield* Effect.tryPromise({
          try: () => input.prepareWorkspace!(request, ownerId, spec.parentThreadId),
          catch: () => new Invalid("Could not prepare the scheduled workspace; it will retry when available"),
        }).pipe(
          Effect.tapError(
            () => sql`UPDATE schedules SET lease_until=${new Date(now.getTime() + 4_000)}
              WHERE id=${schedule.id}::uuid AND status='active' AND version=${schedule.version}
                AND lease_owner=${schedule.lease_owner} AND lease_until=${schedule.lease_until}
                AND next_run_at=${schedule.next_run_at}`,
          ),
        )
      : request;

    return { request: prepared, ownerId, placement } satisfies PreparedSchedule;
  });

/** Revalidate placement after external I/O; a paused/edited schedule is fenced by the caller first. */
export const placementAvailable = (sql: SqlClient.SqlClient, schedule: ScheduleRow, prepared: PreparedSchedule) => sql`
  SELECT pw.id FROM project_workspaces pw JOIN workers w ON w.id=pw.worker_id JOIN projects p ON p.id=pw.project_id
  WHERE pw.id=${prepared.placement.id}::uuid AND pw.project_id=${schedule.project_id}::uuid
    AND pw.worker_id=${prepared.placement.worker_id}::uuid AND p.owner_user_id=${prepared.ownerId}::uuid
    AND pw.archived_at IS NULL AND p.archived_at IS NULL AND w.archived_at IS NULL AND w.revoked_at IS NULL`;

export const scheduledThread = (
  sql: SqlClient.SqlClient,
  schedule: ScheduleRow,
  spec: ui.NewThreadSchedule,
  prepared: PreparedSchedule,
) =>
  Effect.gen(function* () {
    const gateway = yield* GatewayStore;

    let owner = yield* gateway.createThread(prepared.ownerId, { ...prepared.request, initialMessage: "" }, undefined, {
      permissionModeNote: spec.permissionModeNote,
    });

    yield* sql`UPDATE threads SET origin='schedule', schedule_id=${schedule.id}::uuid,
      schedule_name=${schedule.name || schedule.prompt.slice(0, 60)}, schedule_run=${schedule.runs + 1},
      title=${spec.title || schedule.prompt.split("\n")[0]!.slice(0, 60)} WHERE id=${owner.id}::uuid`;
    owner = yield* gateway.thread(owner.id);

    const command = yield* gateway.enqueueCommand({
      workerId: prepared.placement.worker_id,
      threadId: owner.id,
      command: { kind: { case: "createThread", value: { thread: gateway.threadSpec(owner) } } },
      ttlSeconds: 365 * 24 * 3600,
    });

    return { thread: owner, command, newWorktree: prepared.request.workspaceMode === ui.WorkspaceMode.NEW_WORKTREE };
  });
