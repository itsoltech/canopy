import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { PermissionMode, Provider, ProviderProfileKind, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { AgentBusStore, GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("schedule editing with a scripted worker", () => {
  let gw: TestGateway;
  let project: ui.Project;
  let workspace: ui.Workspace;
  let thread: ui.Thread;
  const future = (minutes = 10) => timestampFromDate(new Date(Date.now() + minutes * 60_000));

  const query = <A extends object>(sql: string, params: unknown[] = []) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (s) => s.unsafe<A>(sql, params)));

  const current = async (id: string) =>
    (await gw.api.listSchedules({ includeFinished: true })).schedules.find((s) => s.id === id)!;

  const configuration = (s: ui.Schedule): ui.CreateScheduleRequest =>
    create(ui.CreateScheduleRequestSchema, {
      target: s.target,
      threadId: s.threadId,
      newThread: s.newThread,
      name: s.configuredName,
      prompt: s.prompt,
      when: s.kind === "once" ? { case: "runAt", value: s.runAt! } : { case: "cron", value: s.cron },
      timezone: s.timezone,
      until: s.until,
      maxRuns: s.maxRuns,
      missedPolicy: s.missedPolicy,
      concurrency: s.concurrency,
    });

  const update = async (s: ui.Schedule, extra: MessageInitShape<typeof ui.CreateScheduleRequestSchema> = {}) => {
    const { $typeName, ...fields } = configuration(s);

    return (
      await gw.api.updateSchedule({
        scheduleId: s.id,
        expectedVersion: s.version,
        configuration: create(ui.CreateScheduleRequestSchema, { ...fields, ...extra }),
      })
    ).schedule!;
  };

  const make = async (target: "thread" | "new_thread" = "thread") =>
    (
      await gw.api.createSchedule({
        target,
        threadId: target === "thread" ? thread.id : "",
        name: "Original",
        prompt: "Original message",
        when: { case: "runAt", value: future() },
        ...(target === "new_thread" && {
          newThread: {
            projectId: project.id,
            placement: "any",
            provider: Provider.CODEX,
            model: "gpt-6.1-sol",
            effort: "low",
          },
        }),
      })
    ).schedule!;

  beforeAll(async () => {
    gw = await startTestGateway();
    project = (await gw.api.createProject({ name: "Edit schedules" })).project!;
    workspace = (await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo" }))
      .workspace!;
    thread = (
      await gw.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        title: "Existing target",
      })
    ).thread!;
    await eventually(
      () => gw.api.getThread({ threadId: thread.id }),
      (r) => r.thread?.status === "idle",
    );
    await eventually(
      () => gw.api.getOverview({}),
      (o) => o.workers.every((w) => w.providerInstances.some((i) => i.available)),
    );
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  test("edits thread message/name/timing/policies and keeps history and the creator", async () => {
    const s = await make();

    const recurring = await update(s, {
      prompt: "Edited report",
      name: "Report",
      when: { case: "cron", value: "30 9 * * *" },
      timezone: "Europe/Warsaw",
      missedPolicy: "skip",
      maxRuns: 4,
      until: future(60 * 24 * 10),
    });

    expect(recurring).toMatchObject({
      id: s.id,
      kind: "recurring",
      prompt: "Edited report",
      name: "Report",
      status: "active",
      timezone: "Europe/Warsaw",
      maxRuns: 4,
      missedPolicy: "skip",
      createdBy: "user",
      lastEditedByUserId: gw.userId,
      runs: 0,
    });
    expect(recurring.version).toBeGreaterThan(s.version);
    expect(recurring.lastEditedAt).toBeDefined();
    expect(timestampDate(recurring.nextRunAt!).getUTCHours()).toBe(8);
    await gw.core.scheduler.tick(timestampDate(recurring.nextRunAt!));
    const ran = await current(s.id);
    expect(ran.runs).toBe(1);
    const once = await update(ran, { when: { case: "runAt", value: future(60) }, maxRuns: 0, until: undefined });
    expect(once).toMatchObject({ kind: "once", runs: 1, recentRuns: ran.recentRuns, lastTurnId: ran.lastTurnId });
    await eventually(
      () => gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(thread.id))),
      (rows) => rows.some((r) => r.input.message === "Edited report" && r.status === "completed"),
    );
    await gw.api.setScheduleStatus({ scheduleId: s.id, status: "cancelled" });
  });

  test("edits new-thread project, placement, agent configuration, permissions, title and concurrency", async () => {
    const secondProject = (await gw.api.createProject({ name: "Another project" })).project!;

    const secondWorkspace = (
      await gw.api.createWorkspace({
        projectId: secondProject.id,
        workerId: gw.workerId,
        rootPath: "/repo",
        label: "second",
      })
    ).workspace!;

    const s = await make("new_thread");

    const edited = await update(s, {
      prompt: "Updated new thread",
      concurrency: "allow",
      name: "Updated name",
      newThread: {
        ...s.newThread!,
        projectId: secondProject.id,
        placement: "specific",
        workspaceId: secondWorkspace.id,
        providerProfileId: "native",
        model: "gpt-5.5",
        effort: "high",
        permissionMode: PermissionMode.READ_ONLY,
        title: "Updated title",
      },
    });

    expect(edited).toMatchObject({
      projectId: secondProject.id,
      concurrency: "allow",
      newThread: { model: "gpt-5.5", effort: "high", title: "Updated title" },
    });
    await gw.core.scheduler.tick(timestampDate(edited.nextRunAt!));
    const ran = await current(s.id);

    const spawned = await eventually(
      () => gw.api.getThread({ threadId: ran.recentRuns[0]!.threadId }),
      (r) => r.thread?.status === "idle",
    );

    expect(spawned.thread).toMatchObject({
      projectId: secondProject.id,
      workspaceId: secondWorkspace.id,
      title: "Updated title",
      model: "gpt-5.5",
      effort: "high",
      permissionMode: PermissionMode.READ_ONLY,
    });
    await eventually(
      () => gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(spawned.thread!.id))),
      (rows) => rows[0]?.status === "completed",
    );
    expect(gw.worker.inputs.get(spawned.thread!.id)?.[0]).toContain("Updated new thread");
  });

  test("invalidates a leased snapshot but keeps its occurrence identity, even with the same due time", async () => {
    for (const target of ["thread", "new_thread"] as const) {
      const s = await make(target);
      const now = timestampDate(s.nextRunAt!);

      const claimed = await gw.runtime.runPromise(
        AgentBusStore.use((store) => store.claimDueSchedules("test", now, 60)),
      );

      const stale = claimed.find((row) => row.id === s.id)!;
      expect(stale).toBeDefined();
      const edited = await update(s, { prompt: "Leased occurrence edited" });

      const rejected = await gw.runtime.runPromise(
        AgentBusStore.use((store) =>
          store.fireSchedule({
            schedule: stale,
            input: { note: "stale", message: "stale message" },
            run: true,
            nextRunAt: undefined,
            eligibleWorkerIds: [gw.workerId],
            now,
          }),
        ),
      );

      expect(rejected.turn).toBeUndefined();
      await gw.core.scheduler.tick(now);
      await gw.core.scheduler.tick(now);
      const ran = await current(edited.id);
      expect(ran).toMatchObject({
        runs: 1,
        status: "completed",
        recentRuns: [{ number: 1, scheduledFor: s.nextRunAt }],
      });

      const turns = await query<{ input: { message: string } }>("SELECT input FROM turns WHERE schedule_id = $1", [
        s.id,
      ]);

      expect(turns).toEqual([{ input: expect.objectContaining({ message: "Leased occurrence edited" }) }]);
    }
  });

  test("retimes a claimed occurrence, keeps paused tasks paused and fences conflicting editors/status changes", async () => {
    const s = await make();
    await gw.runtime.runPromise(
      AgentBusStore.use((store) => store.claimDueSchedules("pending", timestampDate(s.nextRunAt!), 60)),
    );
    const moved = await update(s, { when: { case: "runAt", value: future(30) } });
    await gw.core.scheduler.tick(timestampDate(s.nextRunAt!));
    expect((await current(s.id)).runs).toBe(0);
    const paused = (await gw.api.setScheduleStatus({ scheduleId: s.id, status: "paused" })).schedule!;
    const changed = await update(paused, { name: "Still paused", when: { case: "cron", value: "*/15 * * * *" } });
    expect(changed.status).toBe("paused");
    expect(changed.nextRunAt).toBeUndefined();

    try {
      await update(paused, { name: "Stale overwrite" });
      throw new Error("expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectError);
      expect((error as ConnectError).code).toBe(Code.FailedPrecondition);
    }

    const resumed = (await gw.api.setScheduleStatus({ scheduleId: s.id, status: "active" })).schedule!;
    expect(resumed.nextRunAt).toBeDefined();
    await gw.core.scheduler.tick(timestampDate(resumed.nextRunAt!));
    expect((await current(s.id)).recentRuns[0]?.scheduledFor).toEqual(s.nextRunAt);
    expect(moved.runAt).not.toEqual(s.runAt);
    await gw.api.setScheduleStatus({ scheduleId: s.id, status: "cancelled" });
    expect(await failure(update(await current(s.id)))).toContain("cancelled");
  });

  test("create/update share validation; the original thread is fixed; bounded limits cannot be spent twice", async () => {
    const s = await make("new_thread");

    for (const extra of [
      { prompt: " " },
      { when: { case: "cron" as const, value: "* * * * *" } },
      { newThread: { ...s.newThread!, placement: "wrong" } },
      { newThread: { ...s.newThread!, effort: "ultra" } },
      { newThread: { ...s.newThread!, placement: "specific", workspaceId: Bun.randomUUIDv7() } },
    ]) {
      expect(await failure(gw.api.createSchedule({ ...configuration(s), ...extra }))).toBe(
        await failure(update(s, extra)),
      );
    }

    const original = await make();
    expect(await failure(update(original, { threadId: Bun.randomUUIDv7() }))).toBeTruthy();
    await gw.api.setScheduleStatus({ scheduleId: s.id, status: "cancelled" });
    await gw.api.setScheduleStatus({ scheduleId: original.id, status: "cancelled" });
  });

  test("a user may edit an agent's task without replacing its creator, including removing its end", async () => {
    const agent = await gw.worker.callTool({
      threadId: thread.id,
      tool: "schedule_recurring",
      args: { cron: "0 9 * * *", timezone: "UTC", prompt: "Agent task", max_runs: 2 },
    });

    expect(agent.isError).toBe(false);

    const s = (await gw.api.listSchedules({ threadId: thread.id })).schedules.find(
      (entry) => entry.createdBy === "agent",
    )!;

    expect(s).toBeDefined();
    const edited = await update(s, { maxRuns: 0, name: "User edited agent task" });
    expect(edited).toMatchObject({
      createdBy: "agent",
      createdByThreadId: thread.id,
      lastEditedByUserId: gw.userId,
      maxRuns: 0,
    });
    await gw.api.setScheduleStatus({ scheduleId: s.id, status: "cancelled" });
  });

  test("target kind can change while historical run links remain valid", async () => {
    const s = await make();

    const converted = await update(s, {
      target: "new_thread",
      threadId: "",
      when: { case: "cron", value: "*/5 * * * *" },
      newThread: {
        projectId: project.id,
        placement: "specific",
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        model: "gpt-5.5",
        effort: "medium",
      },
    });

    await gw.core.scheduler.tick(timestampDate(converted.nextRunAt!));
    const ran = await current(s.id);
    await eventually(
      () => gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(ran.recentRuns[0]!.threadId))),
      (rows) => rows[0]?.status === "completed",
    );

    const back = await update(ran, {
      target: "thread",
      threadId: thread.id,
      newThread: undefined,
      when: { case: "runAt", value: future(60) },
    });

    expect(back).toMatchObject({
      target: "thread",
      threadId: thread.id,
      runs: 1,
      lastTurnId: ran.lastTurnId,
      recentRuns: ran.recentRuns,
    });
    await gw.core.scheduler.tick(timestampDate(back.nextRunAt!));
    const twice = await current(s.id);
    expect(twice.runs).toBe(2);
    expect(twice.recentRuns.find((r) => r.number === 2)?.threadId).toBe(thread.id);
    expect(await failure(update(twice))).toContain("completed");
  });

  test("parallel editors cannot overwrite one another and a user cannot update another owner's task", async () => {
    const s = await make();

    const results = await Promise.allSettled([
      update(s, { name: "First editor" }),
      update(s, { name: "Second editor" }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as ConnectError).code).toBe(Code.FailedPrecondition);

    const outsider = await gw.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("outsider@test", "Outsider")),
    );

    expect(
      await failure(
        gw.runtime.runPromise(
          AgentBusStore.use((store) =>
            store.updateSchedule({
              scheduleId: s.id,
              expectedVersion: (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<ui.Schedule>)
                .value.version,
              userId: outsider,
              schedule: {
                threadId: thread.id,
                kind: "once",
                prompt: "Unauthorized",
                runAt: timestampDate(s.runAt!),
                nextRunAt: timestampDate(s.runAt!),
                timezone: "UTC",
                hops: 0,
              },
            }),
          ),
        ),
      ),
    ).toContain("schedule not found");
    await gw.api.setScheduleStatus({ scheduleId: s.id, status: "cancelled" });
  });

  test("the edited provider instance is used by the next new thread", async () => {
    await gw.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "scheduled-login",
      create: true,
      label: "Scheduled login",
      kind: ProviderProfileKind.NATIVE,
      allWorkers: true,
    });
    await eventually(
      () => gw.api.getOverview({}),
      (o) => o.workers.some((w) => w.providerInstances.some((i) => i.id === "scheduled-login" && i.available)),
    );
    const s = await make("new_thread");
    const edited = await update(s, { newThread: { ...s.newThread!, providerProfileId: "scheduled-login" } });
    await gw.core.scheduler.tick(timestampDate(edited.nextRunAt!));
    const ran = await current(s.id);

    const spawned = await eventually(
      () => gw.api.getThread({ threadId: ran.recentRuns[0]!.threadId }),
      (r) => r.thread?.status === "idle",
    );

    expect(spawned.thread?.providerProfileId).toBe("scheduled-login");
    await eventually(
      () => gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(spawned.thread!.id))),
      (rows) => rows[0]?.status === "completed",
    );
    expect(gw.worker.created.find((entry) => entry.threadId === spawned.thread!.id)?.providerProfileId).toBe(
      "scheduled-login",
    );
  });
});
