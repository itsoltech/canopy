import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { AgentBusStore, GatewayStore } from "@canopy/gateway/store";
import { GatewayCore } from "@canopy/gateway/core";
import { startGrpcServer } from "@canopy/transport";
import { openGatewayLink } from "@canopy/worker/gateway-link";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, ScriptedWorker, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("new-thread schedules", () => {
  let gw: TestGateway;
  let project: ui.Project;
  let workspaces: ui.Workspace[];
  let second: { workerId: string; credential: string };
  let workerA: ScriptedWorker;
  let workerB: ScriptedWorker;

  const query = <A extends object>(sql: string, params: unknown[] = []) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (s) => s.unsafe<A>(sql, params)));

  beforeAll(async () => {
    gw = await startTestGateway();
    workerA = gw.worker;
    second = await gw.addWorker("server", ["/repo"]);
    workerB = await gw.connect(second.workerId, second.credential);
    project = (await gw.api.createProject({ name: "Scheduled project" })).project!;
    workspaces = await Promise.all(
      [gw.workerId, second.workerId].map(
        async (workerId) =>
          (await gw.api.createWorkspace({ projectId: project.id, workerId, rootPath: "/repo" })).workspace!,
      ),
    );
    await eventually(
      () => gw.api.getOverview({}),
      (o) => o.workers.every((w) => w.providerInstances.some((i) => i.available)),
    );
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  const schedule = async (
    placement = "any",
    extra: Partial<Pick<ui.CreateScheduleRequest, "when" | "concurrency" | "missedPolicy" | "maxRuns" | "until">> = {},
  ) =>
    (
      await gw.api.createSchedule({
        target: "new_thread",
        prompt: "Check the build",
        name: "Build check",
        when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 60_000)) },
        newThread: {
          projectId: project.id,
          placement,
          workspaceId: placement === "specific" ? workspaces[1]!.id : "",
          provider: Provider.CODEX,
          model: "gpt-6.1-sol",
          effort: "low",
          permissionMode: PermissionMode.READ_ONLY,
          title: "Scheduled build",
        },
        ...extra,
      })
    ).schedule!;

  const current = async (id: string) =>
    (await gw.api.listSchedules({ includeFinished: true })).schedules.find((s) => s.id === id)!;

  const fire = async (s: ui.Schedule, offset = 0) => {
    await gw.core.scheduler.tick(new Date(timestampDate(s.nextRunAt!).getTime() + offset));

    return current(s.id);
  };

  test("each policy creates a top-level thread, first scheduled turn, origin and linked history", async () => {
    for (const policy of ["specific", "any", "least_busy", "round_robin"]) {
      const s = await schedule(policy);
      const fired = await fire(s);
      expect(fired.runs).toBe(1);
      const run = fired.recentRuns[0]!;

      const expected =
        policy === "specific" ? workspaces[1]! : [...workspaces].sort((a, b) => a.id.localeCompare(b.id))[0]!;

      expect(run).toMatchObject({
        outcome: "started",
        number: 1,
        workspaceId: expected.id,
        workerId: expected.workerId,
      });

      const thread = await eventually(
        () => gw.api.getThread({ threadId: run.threadId }),
        (r) => r.thread?.status === "idle",
      );

      expect(thread.thread).toMatchObject({
        projectId: project.id,
        parentThreadId: "",
        scheduleId: s.id,
        scheduleName: "Build check",
        scheduleRun: 1,
        permissionMode: PermissionMode.READ_ONLY,
      });

      const turns = await eventually(
        () => gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(run.threadId))),
        (rows) => rows[0]?.status === "completed",
      );

      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        trigger: "schedule",
        schedule_id: s.id,
        input: { message: "Check the build" },
        status: "completed",
      });
      expect((expected.workerId === gw.workerId ? workerA : workerB).inputs.get(run.threadId)?.[0]).toContain(
        "Check the build",
      );
      await gw.core.scheduler.tick(timestampDate(s.nextRunAt!));
      expect((await current(s.id)).runs).toBe(1);
    }
  });

  test("least busy considers active turns and resolves ties deterministically", async () => {
    const first = [...workspaces].sort((a, b) => a.id.localeCompare(b.id))[0]!;
    const busyWorker = first.workerId === gw.workerId ? workerA : workerB;
    busyWorker.holdTurns = true;

    const busy = (
      await gw.api.createThread({
        projectId: project.id,
        workspaceId: first.id,
        provider: Provider.CODEX,
        initialMessage: "hold",
      })
    ).thread!;

    await eventually(
      () => gw.api.getThread({ threadId: busy.id }),
      (r) => r.thread?.status === "running",
    );
    const fired = await fire(await schedule("least_busy"));
    expect(fired.recentRuns[0]?.workerId).not.toBe(first.workerId);
    const held = (await gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(busy.id))))[0]!;
    busyWorker.holdTurns = false;
    busyWorker.finish(busy.id, held.id);
    await eventually(
      () => gw.api.getThread({ threadId: busy.id }),
      (r) => r.thread?.status === "idle",
    );
  });

  test("round robin state and occurrence idempotency survive a gateway scheduler restart", async () => {
    const s = await schedule("round_robin", { when: { case: "cron", value: "*/5 * * * *" }, maxRuns: 3 });
    const first = await fire(s);
    await eventually(
      () => gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(first.recentRuns[0]!.threadId))),
      (rows) => rows[0]?.status === "completed",
    );
    expect(
      (await query<{ placement_cursor: string }>("SELECT placement_cursor FROM schedules WHERE id = $1", [s.id]))[0]
        ?.placement_cursor,
    ).toBe(first.recentRuns[0]!.workspaceId);
    // Reproduce a restart after leasing but before commit: a new gateway reclaims the expired lease.
    const now = timestampDate(first.nextRunAt!);

    const claimed = await gw.runtime.runPromise(
      AgentBusStore.use((store) => store.claimDueSchedules("dead-gateway", now, 1)),
    );

    expect(claimed.some((r) => r.id === s.id)).toBe(true);
    // Both workers reconnect to a fresh gateway on the same database, so the cursor decides the next one.
    workerA.link.close();
    workerB.link.close();
    const restarted = new GatewayCore({ runtime: gw.runtime, instanceId: "restarted", userId: gw.userId });
    const server = await startGrpcServer({ routes: (router) => restarted.link.routes(router) });

    const primary = new ScriptedWorker(
      await openGatewayLink({
        baseUrl: server.url,
        credential: gw.workerCredential,
        hello: { workerId: gw.workerId, journalId: "restart-schedules-primary" },
      }),
    );

    const reconnected = new ScriptedWorker(
      await openGatewayLink({
        baseUrl: server.url,
        credential: second.credential,
        hello: { workerId: second.workerId, journalId: "restart-schedules" },
      }),
    );

    try {
      await eventually(
        async () => restarted.online.size,
        (n) => n === 2,
      );
      await restarted.scheduler.tick(new Date(now.getTime() + 2_000));
      const secondRun = await current(s.id);
      expect(secondRun.runs).toBe(2);
      expect(secondRun.recentRuns[0]?.workerId).toBe(
        workspaces.find((w) => w.id !== first.recentRuns[0]!.workspaceId)!.workerId,
      );
      expect(secondRun.recentRuns[0]?.workerId).not.toBe(first.recentRuns[0]?.workerId);
      const threadId = secondRun.recentRuns[0]!.threadId;
      expect(
        await eventually(
          () => gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(threadId))),
          (rows) => rows[0]?.status === "completed",
        ),
      ).toMatchObject([{ status: "completed" }]);
      await restarted.scheduler.tick(new Date(now.getTime() + 2_000));
      // The old lease holder also cannot commit its stale occurrence after the replacement gateway.
      await gw.runtime.runPromise(
        AgentBusStore.use((store) =>
          store.fireSchedule({
            schedule: claimed.find((r) => r.id === s.id)!,
            input: { note: "stale", message: "duplicate" },
            run: true,
            nextRunAt: new Date(now.getTime() + 300_000),
            eligibleWorkerIds: [second.workerId],
            now: new Date(now.getTime() + 3_000),
          }),
        ),
      );
      expect(
        (await query<{ n: number }>("SELECT count(*)::int AS n FROM threads WHERE schedule_id = $1", [s.id]))[0]?.n,
      ).toBe(2);
    } finally {
      primary.link.close();
      reconnected.link.close();
      await restarted.link.shutdown();
      await server.close();
    }

    workerA = await gw.connect(gw.workerId, gw.workerCredential);
    workerB = await gw.connect(second.workerId, second.credential);
    await gw.api.setScheduleStatus({ scheduleId: s.id, status: "cancelled" });
  });

  test("restart after commit delivers the durable thread and first turn without creating a duplicate", async () => {
    const s = await schedule("specific");
    const now = timestampDate(s.nextRunAt!);

    const claimed = await gw.runtime.runPromise(
      AgentBusStore.use((store) => store.claimDueSchedules("crashed-after-commit", now, 60)),
    );

    // Commit the occurrence without executing the scheduler's created/queued callbacks.
    const result = await gw.runtime.runPromise(
      AgentBusStore.use((store) =>
        store.fireSchedule({
          schedule: claimed.find((row) => row.id === s.id)!,
          input: { note: "Scheduled task", message: s.prompt },
          run: true,
          nextRunAt: undefined,
          eligibleWorkerIds: [second.workerId],
          now,
        }),
      ),
    );

    expect(result.created?.thread.status).toBe("creating");
    expect(result.turn?.status).toBe("queued");
    workerB.link.close();
    const restarted = new GatewayCore({ runtime: gw.runtime, instanceId: "after-commit", userId: gw.userId });
    const server = await startGrpcServer({ routes: (router) => restarted.link.routes(router) });

    const reconnected = new ScriptedWorker(
      await openGatewayLink({
        baseUrl: server.url,
        credential: second.credential,
        hello: { workerId: second.workerId, journalId: "restart-after-commit" },
      }),
    );

    try {
      const threadId = result.threadId;
      await eventually(
        () => gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(threadId))),
        (rows) => rows[0]?.status === "completed",
      );
      expect(reconnected.inputs.get(threadId)?.[0]).toContain(s.prompt);
      await restarted.scheduler.tick(new Date(now.getTime() + 61_000));
      expect((await current(s.id)).runs).toBe(1);
      expect(
        (await query<{ n: number }>("SELECT count(*)::int AS n FROM threads WHERE schedule_id = $1", [s.id]))[0]?.n,
      ).toBe(1);
    } finally {
      reconnected.link.close();
      await restarted.link.shutdown();
      await server.close();
    }

    workerB = await gw.connect(second.workerId, second.credential);
  });

  test("skip_if_running skips an occurrence; allow starts a separate thread", async () => {
    workerB.holdTurns = true;

    for (const concurrency of ["skip_if_running", "allow"]) {
      const s = await schedule("specific", { concurrency, when: { case: "cron", value: "*/5 * * * *" }, maxRuns: 3 });
      const first = await fire(s);
      await eventually(
        () => gw.api.getThread({ threadId: first.recentRuns[0]!.threadId }),
        (r) => r.thread?.status === "running",
      );
      const secondRun = await fire(first);
      expect(secondRun.runs).toBe(concurrency === "allow" ? 2 : 1);
      expect(secondRun.recentRuns[0]?.outcome).toBe(concurrency === "allow" ? "started" : "running");
      await gw.api.setScheduleStatus({ scheduleId: s.id, status: "cancelled" });

      for (const run of secondRun.recentRuns.filter((r) => r.threadId)) {
        const turn = (await gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(run.threadId))))[0]!;
        await eventually(
          () => gw.api.getThread({ threadId: run.threadId }),
          (r) => r.thread?.status === "running",
        );
        workerB.finish(run.threadId, turn.id);
      }
    }

    workerB.holdTurns = false;
  });

  test("offline pools retry the same occurrence; skip expires it and run_once catches up once", async () => {
    workerA.link.close();
    workerB.link.close();
    await eventually(
      async () => gw.core.online.size,
      (n) => n === 0,
    );
    const skip = await schedule("any", { missedPolicy: "skip" });
    expect((await fire(skip)).runs).toBe(0);
    expect(await fire(skip, 121_000)).toMatchObject({
      runs: 0,
      status: "completed",
      recentRuns: [{ outcome: "missed" }],
    });
    const catchUp = await schedule("round_robin");
    expect((await fire(catchUp, 121_000)).runs).toBe(0);
    workerB = await gw.connect(second.workerId, second.credential);
    await eventually(
      async () => gw.core.online.size,
      (n) => n === 1,
    );
    const result = await fire(catchUp, 126_000);
    expect(result.runs).toBe(1);
    expect(result.recentRuns[0]?.workerId).toBe(second.workerId);
    // A specific offline worker still gets one durable thread and a queued first turn.
    workerB.link.close();
    await eventually(
      async () => gw.core.online.size,
      (n) => n === 0,
    );
    const specific = await schedule("specific");
    const offline = await fire(specific);
    expect(offline.runs).toBe(1);

    const turn = (
      await gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(offline.recentRuns[0]!.threadId)))
    )[0]!;

    expect(turn.status).toBe("queued");
    workerB = await gw.connect(second.workerId, second.credential);
    await eventually(
      () => gw.api.getThread({ threadId: offline.recentRuns[0]!.threadId }),
      (r) => r.thread?.status === "idle",
    );
  });

  test("workspace preparation does not block pause, and a paused occurrence cannot commit", async () => {
    const s = await schedule("specific");
    const now = timestampDate(s.nextRunAt!);

    const claimed = await gw.runtime.runPromise(
      AgentBusStore.use((store) => store.claimDueSchedules("preparing", now, 180)),
    );

    let entered = () => {};
    let release = () => {};

    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const firing = gw.runtime.runPromise(
      AgentBusStore.use((store) =>
        store.fireSchedule({
          schedule: claimed.find((row) => row.id === s.id)!,
          input: { note: "scheduled", message: s.prompt },
          run: true,
          nextRunAt: undefined,
          eligibleWorkerIds: [second.workerId],
          now,
          prepareWorkspace: async (request) => {
            entered();
            await hold;

            return request;
          },
        }),
      ),
    );

    try {
      await started;
      await gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SET LOCAL lock_timeout = '250ms'`;
              yield* sql`UPDATE schedules SET status='paused',next_run_at=NULL,version=version+1 WHERE id=${s.id}::uuid`;
            }),
          );
        }),
      );
    } finally {
      release();
    }

    expect(await firing).toEqual({ threadId: "" });
    expect((await current(s.id)).runs).toBe(0);
    expect(await query("SELECT id FROM threads WHERE schedule_id=$1::uuid", [s.id])).toEqual([]);
    await gw.api.setScheduleStatus({ scheduleId: s.id, status: "cancelled" });
  });

  test("failed workspace preparation retries promptly without shortening a replacement lease", async () => {
    for (const replaced of [false, true]) {
      const s = await schedule("specific");
      const now = timestampDate(s.nextRunAt!);

      const claimed = await gw.runtime.runPromise(
        AgentBusStore.use((store) => store.claimDueSchedules("failed-preparation", now, 180)),
      );

      expect(
        await failure(
          gw.runtime.runPromise(
            AgentBusStore.use((store) =>
              store.fireSchedule({
                schedule: claimed.find((row) => row.id === s.id)!,
                input: { note: "scheduled", message: s.prompt },
                run: true,
                nextRunAt: undefined,
                eligibleWorkerIds: [second.workerId],
                now,
                prepareWorkspace: async () => {
                  if (replaced) await query("UPDATE schedules SET lease_owner='replacement' WHERE id=$1::uuid", [s.id]);

                  throw new Error("Synthetic unavailable workspace");
                },
              }),
            ),
          ),
        ),
      ).toContain("Could not prepare the scheduled workspace");

      const retried = await gw.runtime.runPromise(
        AgentBusStore.use((store) =>
          store.claimDueSchedules("retry-preparation", new Date(now.getTime() + 5_000), 180),
        ),
      );

      expect(retried.some((row) => row.id === s.id)).toBe(!replaced);
      expect((await current(s.id)).runs).toBe(0);
      expect(await query("SELECT id FROM threads WHERE schedule_id=$1::uuid", [s.id])).toEqual([]);
      await gw.api.setScheduleStatus({ scheduleId: s.id, status: "cancelled" });
    }
  });

  test("a workspace archived during preparation is revalidated before creating a thread", async () => {
    const s = await schedule("specific");
    const now = timestampDate(s.nextRunAt!);

    const claimed = await gw.runtime.runPromise(
      AgentBusStore.use((store) => store.claimDueSchedules("preparing", now, 180)),
    );

    const workspace = workspaces[1]!;

    try {
      const result = await gw.runtime.runPromise(
        AgentBusStore.use((store) =>
          store.fireSchedule({
            schedule: claimed.find((row) => row.id === s.id)!,
            input: { note: "scheduled", message: s.prompt },
            run: true,
            nextRunAt: undefined,
            eligibleWorkerIds: [second.workerId],
            now,
            prepareWorkspace: async (request) => {
              await query("UPDATE project_workspaces SET archived_at=now() WHERE id=$1::uuid", [workspace.id]);

              return request;
            },
          }),
        ),
      );

      expect(result).toEqual({ threadId: "" });
      expect(await query("SELECT id FROM threads WHERE schedule_id=$1::uuid", [s.id])).toEqual([]);
    } finally {
      await query("UPDATE project_workspaces SET archived_at=NULL WHERE id=$1::uuid", [workspace.id]);
      await gw.api.setScheduleStatus({ scheduleId: s.id, status: "cancelled" });
    }
  });

  test("validates ownership, target, model/effort, project workspace and minimum cron interval", async () => {
    const s = await schedule();
    await gw.api.setScheduleStatus({ scheduleId: s.id, status: "cancelled" });
    expect(await failure(schedule("unknown"))).toContain("placement");
    expect(await failure(schedule("any", { when: { case: "cron", value: "* * * * *" } }))).toContain("more often");
    expect(await failure(gw.api.createSchedule({ target: "new_thread", prompt: "x" }))).toContain("configuration");
  });
});
