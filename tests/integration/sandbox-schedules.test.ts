import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { SANDBOX_PROFILES_CAPABILITY } from "@canopy/domain/sandbox-profiles";
import {
  eventually,
  failure,
  startTestGateway,
  type ScriptedWorkerOptions,
  type TestGateway,
} from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("scheduled sandbox profiles", () => {
  let gw: TestGateway;
  let projectId: string;
  let modernWorkspace: string;
  let legacyWorkspace: string;
  let legacyWorker: { workerId: string; credential: string };
  const profile = { id: Bun.randomUUIDv7(), name: "Offline", allowedDomains: [] };

  const modern = {
    hello: { capabilities: [SANDBOX_PROFILES_CAPABILITY, "thread_resource_cleanup_v1"] },
    sandboxOffline: true,
  } satisfies ScriptedWorkerOptions;

  const saveProfiles = async (profiles: (typeof profile)[]) => {
    const { user } = await gw.api.getSettings({});
    await gw.api.updateUserSettings({ expectedVersion: user!.version, sandboxProfiles: { profiles } });
  };

  const waitForReport = async (workerId: string, sandbox: boolean) => {
    const overview = await eventually(
      () => gw.api.getOverview({}),
      (state) =>
        state.workers.some(
          (worker) =>
            worker.id === workerId &&
            worker.providerInstances.some((instance) => instance.harness === Provider.CODEX && instance.available) &&
            worker.profiles.some(
              (report) =>
                report.available &&
                report.providers.includes(Provider.CODEX) &&
                Boolean(report.sandboxSupport?.offline) === sandbox,
            ),
        ),
    );

    expect(
      overview.workers.some(
        (worker) =>
          worker.id === workerId &&
          worker.profiles.some(
            (report) =>
              report.available &&
              report.providers.includes(Provider.CODEX) &&
              Boolean(report.sandboxSupport?.offline) === sandbox,
          ),
      ),
    ).toBe(true);
  };

  beforeAll(async () => {
    gw = await startTestGateway({ worker: modern });
    legacyWorker = await gw.addWorker("Legacy");
    await gw.connect(legacyWorker.workerId, legacyWorker.credential, undefined, { hello: { capabilities: [] } });
    await gw.api.setInstanceWorkers({ harness: Provider.CODEX, id: "native", allWorkers: true });
    await waitForReport(gw.workerId, true);
    await waitForReport(legacyWorker.workerId, false);
    projectId = (await gw.api.createProject({ name: "Sandbox schedules" })).project!.id;
    modernWorkspace = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/current" }))
      .workspace!.id;
    legacyWorkspace = (
      await gw.api.createWorkspace({ projectId, workerId: legacyWorker.workerId, rootPath: "/repo/legacy" })
    ).workspace!.id;
    await saveProfiles([profile]);
  }, 60_000);

  afterAll(async () => gw?.close());

  const configuration = (
    overrides: MessageInitShape<typeof ui.NewThreadScheduleSchema> = {},
    runAt = new Date(Date.now() + 60_000),
  ): MessageInitShape<typeof ui.CreateScheduleRequestSchema> => ({
    target: "new_thread",
    prompt: "Inspect the current build",
    when: { case: "runAt", value: timestampFromDate(runAt) },
    newThread: {
      projectId,
      placement: "any",
      provider: Provider.CODEX,
      permissionMode: PermissionMode.FULL_AUTO,
      sandboxProfileId: profile.id,
      ...overrides,
    },
  });

  const current = async (id: string) =>
    (await gw.api.listSchedules({ includeFinished: true })).schedules.find((schedule) => schedule.id === id)!;

  const run = async (schedule: ui.Schedule, offsetMs = 0) => {
    await gw.core.scheduler.tick(new Date(timestampDate(schedule.nextRunAt!).getTime() + offsetMs));

    return current(schedule.id);
  };

  test("preserves a pinned policy across catalog deletion and places only on a capable worker", async () => {
    const request = configuration();
    const created = (await gw.api.createSchedule(request)).schedule!;
    const binding = created.newThread?.sandboxProfile;
    expect(binding?.profile?.id).toBe(profile.id);

    await saveProfiles([{ ...profile, name: "Edited elsewhere" }]);

    const echoed = (
      await gw.api.updateSchedule({
        scheduleId: created.id,
        expectedVersion: created.version,
        configuration: configuration(
          { sandboxProfile: { profile: { ...profile, name: "Caller-supplied" }, digest: "caller-supplied" } },
          timestampDate(created.runAt!),
        ),
      })
    ).schedule!;

    expect(echoed.newThread?.sandboxProfile).toEqual(binding);

    await saveProfiles([]);

    const edited = (
      await gw.api.updateSchedule({
        scheduleId: echoed.id,
        expectedVersion: echoed.version,
        configuration: configuration({ sandboxProfileId: undefined }, timestampDate(created.runAt!)),
      })
    ).schedule!;

    expect(edited.newThread?.sandboxProfile).toEqual(binding);

    const fired = await run(edited);
    expect(fired.recentRuns[0]?.workerId).toBe(gw.workerId);
    const { threadId, turnId } = fired.recentRuns[0]!;

    const start = await eventually(
      async () => gw.worker.commands.find((command) => command.case === "startTurn" && command.value.turnId === turnId),
      (command) => Boolean(command),
    );

    expect((await gw.api.getThread({ threadId })).thread?.sandboxProfile).toEqual(binding);
    expect(start?.case === "startTurn" && start.value.profiledThread?.binding).toEqual(binding);
    expect(start?.case === "startTurn" && start.value.thread).toBeUndefined();

    const create = gw.worker.commands.find(
      (command) => command.case === "createThread" && command.value.profiledThread?.thread?.threadId === threadId,
    );

    expect(create?.case === "createThread" && create.value.profiledThread?.binding).toEqual(binding);
    expect(create?.case === "createThread" && create.value.thread).toBeUndefined();

    await saveProfiles([profile]);
  });

  test("requires owner selection and refreshes a snapshot only after an explicit clear", async () => {
    expect(
      await failure(gw.core.createSchedule(create(ui.CreateScheduleRequestSchema, configuration()), "bot")),
    ).toContain("Only the owner");
    expect(
      await failure(gw.api.createSchedule(configuration({ permissionMode: PermissionMode.FULL_ACCESS }))),
    ).toContain("Choose Sandbox");
    expect(await failure(gw.api.createSchedule(configuration({ sandboxProfileId: Bun.randomUUIDv7() })))).toContain(
      "available sandbox profile",
    );
    const created = (await gw.api.createSchedule(configuration())).schedule!;

    const cleared = (
      await gw.api.updateSchedule({
        scheduleId: created.id,
        expectedVersion: created.version,
        configuration: configuration({ sandboxProfileId: "", permissionMode: PermissionMode.ASK }),
      })
    ).schedule!;

    expect(cleared.newThread?.sandboxProfile).toBeUndefined();
    await saveProfiles([{ ...profile, name: "Fresh" }]);

    const refreshed = (
      await gw.api.updateSchedule({
        scheduleId: cleared.id,
        expectedVersion: cleared.version,
        configuration: configuration(),
      })
    ).schedule!;

    expect(refreshed.newThread?.sandboxProfile?.profile?.name).toBe("Fresh");
    expect(refreshed.newThread?.sandboxProfile?.digest).not.toBe(created.newThread?.sandboxProfile?.digest);
    await saveProfiles([profile]);
    await gw.api.setScheduleStatus({ scheduleId: refreshed.id, status: "cancelled" });
  });

  test("retries a specific workspace after its old worker gains sandbox support", async () => {
    const created = (
      await gw.api.createSchedule(configuration({ placement: "specific", workspaceId: legacyWorkspace }))
    ).schedule!;

    const waiting = await run(created);
    expect(waiting.recentRuns).toHaveLength(0);
    expect(waiting.nextRunAt).toEqual(created.nextRunAt);
    const upgraded = await gw.connect(legacyWorker.workerId, legacyWorker.credential, undefined, modern);
    await waitForReport(legacyWorker.workerId, true);
    const fired = await run(created, 5_000);
    expect(fired.recentRuns[0]?.workerId).toBe(legacyWorker.workerId);
    const turnId = fired.recentRuns[0]?.turnId ?? "";
    const started = await eventually(async () => upgraded.started.get(turnId), Boolean);
    expect(started?.text).toContain("Inspect the current build");
    expect((await gw.api.getThread({ threadId: fired.recentRuns[0]!.threadId })).thread?.sandboxProfile).toEqual(
      created.newThread?.sandboxProfile,
    );
  });

  test("existing bound schedules queue ordinary agent input, including a literal leading bang", async () => {
    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId: modernWorkspace,
        provider: Provider.CODEX,
        permissionMode: PermissionMode.FULL_AUTO,
        sandboxProfileId: profile.id,
      })
    ).thread!;

    expect(
      (
        await eventually(
          () => gw.api.getThread({ threadId: thread.id }),
          (value) => value.thread?.status === "idle",
        )
      ).thread?.status,
    ).toBe("idle");

    const schedule = (
      await gw.api.createSchedule({
        threadId: thread.id,
        prompt: "!This is text in a scheduled message",
        when: { case: "runAt", value: timestampFromDate(new Date(Date.now() + 60_000)) },
      })
    ).schedule!;

    const fired = await run(schedule);

    const start = await eventually(
      async () =>
        gw.worker.commands.find(
          (command) => command.case === "startTurn" && command.value.turnId === fired.recentRuns[0]?.turnId,
        ),
      Boolean,
    );

    expect(start?.case).toBe("startTurn");

    if (start?.case === "startTurn") {
      expect(start.value.profiledThread?.binding).toEqual(thread.sandboxProfile);
      expect(start.value.input?.text).toContain("!This is text in a scheduled message");
      expect(start.value.input?.shellCommand).toBeUndefined();
    }
  });
});
