import { create } from "@bufbuild/protobuf";
import { PermissionMode, ui } from "@canopy/contracts";
import { Effect } from "effect";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { DEFAULT_BUS_LIMITS } from "@canopy/domain";
import { AgentBusStore, harnessOf, toUiSchedule, type NewSchedule } from "../store/index.ts";
import { cronProblem, nextCronRun } from "./cron.ts";
import { scheduleConfiguration } from "./schedule-configuration.ts";
import { PLACEMENTS } from "@canopy/domain";
import { coreState, InvalidError, isTimeZone } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreCheckModel } from "./core-models.ts";
import { coreInstances, coreWorkers } from "./core-providers.ts";
import { coreRun } from "./core-broadcast.ts";
import { splitId } from "@canopy/domain/computers";
import { refuseRemoteAutomation } from "../worktrees/remote.ts";

export async function coreScheduleConfiguration(
  hostContext: GatewayCore,
  request: ui.CreateScheduleRequest,
): Promise<NewSchedule> {
  const target = request.target || "thread";

  if (target !== "thread" && target !== "new_thread") throw new InvalidError("target is thread or new_thread");
  const concurrency = request.concurrency || "skip_if_running";

  if (concurrency !== "allow" && concurrency !== "skip_if_running")
    throw new InvalidError("concurrency is allow or skip_if_running");
  let newThread: ui.NewThreadSchedule | undefined;

  if (target === "thread") {
    if (request.newThread) throw new InvalidError("thread target cannot include new_thread");
    const thread = await coreRun(hostContext, (s) => s.thread(request.threadId));

    if (thread.owner_user_id !== hostContext[coreState].options.userId || thread.deleted_at)
      throw new InvalidError("thread not found");

    if (thread.archived_at) throw new InvalidError("the thread is archived");
  } else {
    if (request.threadId || !request.newThread)
      throw new InvalidError("new_thread requires its configuration and no thread_id");
    const spec = request.newThread;

    if (splitId(spec.workspaceId).node || splitId(spec.projectId).node || splitId(spec.parentThreadId).node)
      refuseRemoteAutomation("new_worktree");

    if (
      ![
        ui.WorkspaceMode.UNSPECIFIED,
        ui.WorkspaceMode.CHECKOUT,
        ui.WorkspaceMode.NEW_WORKTREE,
        ui.WorkspaceMode.INHERIT_PARENT,
      ].includes(spec.workspaceMode)
    )
      throw new InvalidError("choose the scoped default, current checkout, new worktree or inherit parent");

    if (spec.workspaceMode === ui.WorkspaceMode.INHERIT_PARENT) {
      if (!spec.parentThreadId || spec.placement !== "specific")
        throw new InvalidError("inherit_parent requires a parent thread and specific workspace");
      const parent = await coreRun(hostContext, (s) => s.thread(spec.parentThreadId));

      if (
        parent.owner_user_id !== hostContext[coreState].options.userId ||
        parent.project_id !== spec.projectId ||
        parent.workspace_id !== spec.workspaceId
      )
        throw new InvalidError("parent thread must belong to this project and workspace");
    } else if (spec.parentThreadId) throw new InvalidError("parent_thread_id is only for inherit_parent");
    const placement = spec.placement || "any";

    if (!PLACEMENTS.some((p) => p === placement)) throw new InvalidError("unknown placement policy");

    if (!harnessOf(spec.provider)) throw new InvalidError("choose a provider");

    if (!Object.values(PermissionMode).includes(spec.permissionMode)) throw new InvalidError("unknown permission mode");

    const project = (await coreRun(hostContext, (s) => s.listProjects(hostContext[coreState].options.userId))).find(
      (p) => p.id === spec.projectId,
    );

    if (!project) throw new InvalidError("project not found");
    const workspaces = project.workspaces.filter((w) => placement !== "specific" || w.id === spec.workspaceId);

    if (!workspaces.length || (placement !== "specific" && spec.workspaceId))
      throw new InvalidError("choose a workspace of the project only for specific placement");

    const instance = await coreInstances(hostContext, (s) =>
      s.get(harnessOf(spec.provider)!, spec.providerProfileId || "native"),
    );

    if (!instance) throw new InvalidError("provider instance not found");
    const workers = await coreWorkers(hostContext);

    const candidates = workspaces.filter((w) =>
      workers
        .find((worker) => worker.id === w.workerId)
        ?.providerInstances.some(
          (i) => i.harness === spec.provider && i.id === (spec.providerProfileId || "native") && i.enabled,
        ),
    );

    if (!candidates.length)
      throw new InvalidError("the provider instance is not enabled on any workspace of this project");

    // Validate against each known catalog: a pool may contain different CLI versions/catalogs.
    for (const workspace of candidates)
      await coreCheckModel(
        hostContext,
        { workspaceId: workspace.id, provider: spec.provider, profileId: spec.providerProfileId },
        spec.model,
        spec.effort,
      );
    newThread = create(ui.NewThreadScheduleSchema, {
      ...spec,
      placement,
      title: spec.title.trim(),
      // Unattended schedules retain their existing sandbox ceiling.
      permissionMode:
        spec.permissionMode === PermissionMode.FULL_ACCESS
          ? PermissionMode.FULL_AUTO
          : spec.permissionMode || PermissionMode.ASK,
      permissionModeNote:
        spec.permissionMode === PermissionMode.FULL_ACCESS
          ? "Scheduled threads limit Full access to Full auto. Keep this mode or choose one that asks."
          : "",
    });
  }

  try {
    return { ...scheduleConfiguration(request, new Date()), ...(newThread && { newThread }) };
  } catch (error) {
    throw new InvalidError(error instanceof Error ? error.message : "invalid schedule");
  }
}

export async function corePublishSchedule(hostContext: GatewayCore, scheduleId: string): Promise<void> {
  const row = await coreBus(hostContext, (s) => s.schedule(scheduleId)).catch(() => undefined);

  if (row) coreAnnounceSchedule(hostContext, toUiSchedule(row));
}

export function coreAnnounceSchedule(hostContext: GatewayCore, schedule: ui.Schedule): void {
  if (schedule.threadId)
    hostContext.hub.publishThread(
      schedule.threadId,
      create(ui.ThreadUpdateSchema, { change: { case: "schedule", value: schedule } }),
    );
  hostContext.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "schedule", value: schedule } }));
}

export function coreBus<A, E>(
  hostContext: GatewayCore,
  use: (store: AgentBusStore["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  return hostContext[coreState].actions.run(AgentBusStore.use(use));
}

export interface CoreSchedulesMethods {
  listSchedules(request: ui.ListSchedulesRequest): Promise<ui.Schedule[]>;
  createSchedule(request: ui.CreateScheduleRequest): Promise<ui.Schedule>;
  updateSchedule(request: ui.UpdateScheduleRequest): Promise<ui.Schedule>;
  previewSchedule(request: ui.PreviewScheduleRequest): ui.PreviewScheduleResponse;
  setScheduleStatus(request: ui.SetScheduleStatusRequest): Promise<ui.Schedule>;
}

export const coreSchedulesMethods: CoreSchedulesMethods = {
  // ------------------------------------------------------------------ schedules (UI)

  async listSchedules(this: GatewayCore, request: ui.ListSchedulesRequest): Promise<ui.Schedule[]> {
    const rows = await coreBus(this, (s) =>
      s.schedulesFor({
        ownerUserId: this[coreState].options.userId,
        projectId: request.projectId,
        threadId: request.threadId,
        includeFinished: request.includeFinished,
      }),
    );

    return rows.map(toUiSchedule);
  },

  /** A user's schedule: like an agent's, but it may be open-ended and starts no agent chain (hops 0). */
  async createSchedule(this: GatewayCore, request: ui.CreateScheduleRequest): Promise<ui.Schedule> {
    const configuration = await coreScheduleConfiguration(this, request);

    const row = await coreBus(this, (s) =>
      s.createUserSchedule({ userId: this[coreState].options.userId, schedule: configuration }),
    );

    const schedule = toUiSchedule(row);
    coreAnnounceSchedule(this, schedule);

    return schedule;
  },

  async updateSchedule(this: GatewayCore, request: ui.UpdateScheduleRequest): Promise<ui.Schedule> {
    if (!request.configuration) throw new InvalidError("configuration is required");

    if (!request.expectedVersion) throw new InvalidError("expected_version is required");
    const configuration = await coreScheduleConfiguration(this, request.configuration);
    const previous = await coreBus(this, (s) => s.schedule(request.scheduleId));

    const row = await coreBus(this, (s) =>
      s.updateSchedule({
        scheduleId: request.scheduleId,
        expectedVersion: request.expectedVersion,
        userId: this[coreState].options.userId,
        schedule: configuration,
      }),
    );

    const schedule = toUiSchedule(row);

    if (previous.thread_id && previous.thread_id !== row.thread_id) {
      this.hub.publishThread(
        previous.thread_id,
        create(ui.ThreadUpdateSchema, { change: { case: "schedule", value: schedule } }),
      );
    }

    coreAnnounceSchedule(this, schedule);

    return schedule;
  },

  /** Next runs of a cron in a time zone, validated like CreateSchedule. */
  previewSchedule(this: GatewayCore, request: ui.PreviewScheduleRequest): ui.PreviewScheduleResponse {
    const timezone = request.timezone || "UTC";

    if (!isTimeZone(timezone)) throw new InvalidError(`unknown time zone ${timezone}`);
    const now = new Date();
    const problem = cronProblem(request.cron, timezone, DEFAULT_BUS_LIMITS.minCronMinutes, now);

    if (problem) throw new InvalidError(problem);
    const count = Math.min(Math.max(request.count || 5, 1), 20);
    const nextRuns = [];

    for (let at = now; nextRuns.length < count;) {
      const next = nextCronRun(request.cron, timezone, at);

      if (!next) break;
      nextRuns.push(timestampFromDate(next));
      at = next;
    }

    return create(ui.PreviewScheduleResponseSchema, { nextRuns });
  },

  async setScheduleStatus(this: GatewayCore, request: ui.SetScheduleStatusRequest): Promise<ui.Schedule> {
    const status = request.status;

    if (status !== "active" && status !== "paused" && status !== "cancelled")
      throw new InvalidError("status is active, paused or cancelled");
    const current = await coreBus(this, (s) => s.schedule(request.scheduleId));

    if (current.owner_user_id !== this[coreState].options.userId) throw new InvalidError("schedule not found");
    let nextRunAt: Date | undefined;

    if (status === "active") {
      // Resumed: a missed one-off runs now; a recurring one continues from now.
      const now = new Date();
      nextRunAt =
        current.kind === "once"
          ? new Date(Math.max(new Date(current.run_at ?? now).getTime(), now.getTime()))
          : current.cron
            ? nextCronRun(current.cron, current.timezone, now)
            : undefined;

      if (!nextRunAt) throw new InvalidError("the schedule has no future runs");
    }

    const row = await coreBus(this, (s) =>
      s.setScheduleStatus({
        scheduleId: request.scheduleId,
        expectedVersion: current.version,
        status,
        ...(nextRunAt && { nextRunAt }),
      }),
    );

    const schedule = toUiSchedule(row);
    coreAnnounceSchedule(this, schedule);

    return schedule;
  },
};
