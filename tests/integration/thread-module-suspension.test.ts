import { create } from "@bufbuild/protobuf";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ItemStatus, Provider, TurnOrigin, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { AgentBusStore, GatewayStore, GoalStore, SteerStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("Threads module execution", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;

  beforeAll(async () => {
    gw = await startTestGateway({ worker: { hello: { capabilities: ["thread_resource_cleanup_v1"] } } });
    projectId = (await gw.api.createProject({ name: "Module suspension" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  async function thread() {
    const threadId = (await gw.api.createThread({ workspaceId, projectId, provider: Provider.CODEX, title: "Work" }))
      .thread!.id;

    await eventually(
      () => gw.api.getThread({ threadId }),
      (r) => r.thread?.status === "idle",
    );

    return threadId;
  }

  async function toggle(enabled: boolean) {
    const { user } = await gw.api.getSettings({});
    await gw.api.updateUserSettings({
      expectedVersion: user!.version,
      modules: { enabled: enabled ? ["threads", "bots"] : ["bots"] },
    });
  }

  test("a disabled owner does not block another owner's schedule for new threads", async () => {
    const other = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other@example.test", "Other")));
    const project = await gw.runtime.runPromise(GatewayStore.use((s) => s.createProject(other, "Other schedules")));
    const now = new Date();

    const otherSchedule = await gw.runtime.runPromise(
      AgentBusStore.use((s) =>
        s.createUserSchedule({
          userId: other,
          schedule: {
            threadId: "",
            kind: "once",
            prompt: "Other work",
            runAt: now,
            timezone: "UTC",
            nextRunAt: now,
            hops: 0,
            newThread: create(ui.NewThreadScheduleSchema, {
              projectId: project.id,
              placement: "any",
              provider: Provider.CODEX,
            }),
          },
        }),
      ),
    );

    try {
      await toggle(false);
      expect(await gw.core.scheduler.tick(now)).toBe(0);
      const due = await gw.runtime.runPromise(AgentBusStore.use((s) => s.claimDueSchedules("other-owner", now, 60)));
      expect(due.map((s) => s.id)).toEqual([otherSchedule.id]);
    } finally {
      await gw.runtime.runPromise(AgentBusStore.use((s) => s.cancelSchedule(otherSchedule.id)));
      await toggle(true);
    }
  });

  test("a fresh scheduler skips disabled work, rejects a stale lease and resumes only eligible occurrences", async () => {
    const threadId = await thread();

    const once = (
      await gw.api.createSchedule({
        threadId,
        target: "thread",
        prompt: "Wake",
        when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 60_000)) },
      })
    ).schedule!;

    const skip = (
      await gw.api.createSchedule({
        threadId,
        target: "thread",
        prompt: "Skip late",
        missedPolicy: "skip",
        when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 60_000)) },
      })
    ).schedule!;

    const periodic = (
      await gw.api.createSchedule({
        threadId,
        target: "thread",
        prompt: "Every hour",
        timezone: "UTC",
        when: { case: "cron", value: "0 * * * *" },
        maxRuns: 2,
      })
    ).schedule!;

    const obsolete = (
      await gw.api.createSchedule({
        threadId,
        prompt: "Earlier parser",
        when: { case: "cron", value: "0 * * * *" },
      })
    ).schedule!;

    const paused = (
      await gw.api.createSchedule({
        threadId,
        target: "thread",
        prompt: "Manual pause",
        when: { case: "cron", value: "0 * * * *" },
      })
    ).schedule!;

    await gw.api.setScheduleStatus({ scheduleId: paused.id, status: "paused" });
    const due = new Date(Date.now() - 4 * 3_600_000);
    await gw.runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE schedules SET next_run_at = ${due}
      WHERE id = ANY(${[once.id, skip.id, periodic.id]}::uuid[])`,
      ),
    );

    await gw.runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql`UPDATE schedules SET next_run_at = ${due}, timezone = 'Retired/Zone' WHERE id = ${obsolete.id}::uuid`,
      ),
    );

    const [claim] = await gw.runtime.runPromise(
      AgentBusStore.use((s) => s.claimDueSchedules("before-disable", new Date(), 180, 1)),
    );

    expect(claim).toBeDefined();
    await toggle(false);
    const fresh = new GatewayCore({ runtime: gw.runtime, userId: gw.userId, instanceId: "after-disable" });

    try {
      expect(await fresh.scheduler.tick()).toBe(0);

      const stale = () =>
        gw.runtime.runPromise(
          AgentBusStore.use((s) =>
            s.fireSchedule({
              schedule: claim!,
              input: { note: "stale claim", message: "stale" },
              run: true,
              nextRunAt: undefined,
              eligibleWorkerIds: [],
              now: new Date(),
            }),
          ),
        );

      expect((await stale()).turn).toBeUndefined();
      const resumedAt = Date.now();
      await toggle(true);
      expect((await stale()).turn).toBeUndefined();
      expect(await gw.core.scheduler.tick()).toBe(2);
      expect(await gw.core.scheduler.tick()).toBe(0);
      const schedules = (await gw.api.listSchedules({ threadId, includeFinished: true })).schedules;
      expect(schedules.find((s) => s.id === once.id)).toMatchObject({ status: "completed", runs: 1 });
      expect(schedules.find((s) => s.id === skip.id)).toMatchObject({ status: "completed", runs: 0 });
      expect(schedules.find((s) => s.id === obsolete.id)).toMatchObject({ status: "completed", runs: 0 });
      const next = schedules.find((s) => s.id === periodic.id)!;
      expect(next).toMatchObject({ status: "active", runs: 0 });
      expect(timestampDate(next.nextRunAt!).getTime()).toBeGreaterThan(resumedAt);
      expect(timestampDate(next.nextRunAt!).getUTCMinutes()).toBe(0);
      expect(schedules.find((s) => s.id === paused.id)).toMatchObject({ status: "paused", runs: 0 });
    } finally {
      await fresh.link.shutdown();
      await toggle(true);
    }
  });

  test.each(["accepted", "in flight"])(
    "a steer %s at suspension never becomes a second turn before its journal receipt",
    async (stage) => {
      const threadId = await thread();
      gw.worker.holdTurns = true;
      let acknowledge: (() => void) | undefined;
      gw.worker.handlers.set("steerTurn", (_value, reply) => {
        acknowledge = () => reply(true);

        if (stage === "accepted") acknowledge();
      });

      try {
        const active = (await gw.api.sendMessage({ threadId, text: "Working" })).turn!;
        await eventually(
          () => gw.api.getThread({ threadId }),
          (r) => r.thread?.status === "running",
        );

        const steer = (await gw.api.sendMessage({ threadId, text: "Applied once", delivery: ui.MessageDelivery.STEER }))
          .steer!;

        const receipt = () => gw.runtime.runPromise(SteerStore.use((s) => s.steer(steer.id)));
        await eventually(receipt, (s) => (stage === "accepted" ? s.status === "accepted" : acknowledge !== undefined));
        await toggle(false);

        if (stage === "in flight") acknowledge?.();
        await toggle(true);
        gw.worker.emit(threadId, active.id, {
          case: "itemCompleted",
          value: {
            item: {
              itemId: steer.id,
              status: ItemStatus.COMPLETED,
              content: { case: "userMessage", value: { clientId: steer.id, text: "Applied once" } },
            },
          },
        });
        await eventually(receipt, (s) => s.status === "delivered");
        await gw.core.pump(threadId);
        expect(gw.worker.inputs.get(threadId)).toEqual(["Working"]);
      } finally {
        gw.worker.holdTurns = false;
        gw.worker.handlers.delete("steerTurn");
        await toggle(true);
      }
    },
  );

  test("interrupts in-flight work, holds queued input through recovery, and resumes only previously active goals", async () => {
    const threadId = await thread();
    const manual = await thread();
    const turns = () => gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(threadId)));
    const goal = (id: string) => gw.runtime.runPromise(GoalStore.use((s) => s.latest(id)));
    gw.worker.holdTurns = true;

    try {
      await gw.api.setGoal({ threadId, action: "set", objective: "Continue work" });
      gw.worker.emit(threadId, "", {
        case: "goalState",
        value: { nativeStatus: "active", objective: "Continue work", tokensUsed: 35n },
      });
      await eventually(
        () => goal(threadId),
        (g) => g?.native_status === "active",
      );
      await gw.api.setGoal({ threadId: manual, action: "set", objective: "Paused work" });
      await gw.api.setGoal({ threadId: manual, action: "pause" });
      const active = (await gw.api.sendMessage({ threadId, text: "First" })).turn!;
      await eventually(turns, (rows) => rows[0]?.status === "running");
      await gw.api.sendMessage({ threadId, text: "Second" });
      await toggle(false);
      await eventually(
        async () => gw.worker.commands,
        (commands) => commands.some((c) => c.case === "interruptTurn" && c.value.turnId === active.id),
      );
      gw.worker.emit(threadId, active.id, {
        case: "turnStarted",
        value: { providerTurnRef: "late", origin: TurnOrigin.PROVIDER },
      });
      await eventually(
        () =>
          gw.runtime.runPromise(
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) => sql`SELECT 1 FROM thread_events
        WHERE thread_id = ${threadId}::uuid AND payload #>> '{turnStarted,providerTurnRef}' = 'late'`,
            ),
          ),
        (rows) => rows.length === 1,
      );
      await gw.core.sweep();
      await gw.core.pump(threadId);
      expect((await turns()).map((u) => u.status)).toEqual(["interrupted", "queued"]);
      expect((await goal(threadId))?.status).toBe("paused");
      expect(gw.worker.inputs.get(threadId)).toEqual(["First"]);
      gw.worker.holdTurns = false;
      await toggle(true);
      await eventually(turns, (rows) => rows[1]?.status === "completed");
      expect(gw.worker.inputs.get(threadId)).toEqual(["First", "Second"]);
      expect((await goal(threadId))?.status).toBe("active");
      expect((await goal(manual))?.status).toBe("paused");
      const commands = gw.worker.commands.flatMap((c) => (c.case === "setGoal" ? [c.value] : []));
      expect(commands.filter((c) => c.threadId === threadId).map((c) => c.objective)).toEqual(["Continue work", ""]);
      expect(Number((await goal(threadId))?.tokens_used)).toBe(35);
      expect(commands.filter((c) => c.threadId === manual && c.objective === "Paused work")).toHaveLength(1);
    } finally {
      gw.worker.holdTurns = false;
      await toggle(true);
    }
  });
});
