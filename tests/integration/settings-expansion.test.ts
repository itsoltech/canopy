import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, fromJson } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore, SettingsStore } from "@canopy/gateway/store";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("settings expansion persistence, checks and owner boundaries", () => {
  let gw: TestGateway;
  let other: GatewayCore;
  let otherId = "";
  let requests = 0;
  let registryGate: Promise<void> | undefined;

  const registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      requests++;
      await registryGate;

      return new Response("2.0.0");
    },
  });

  const url = `http://127.0.0.1:${registry.port}`;
  const latest = { sources: { claude: url, codex: url, grok: url }, allowHttpForTests: true };

  beforeAll(async () => {
    gw = await startTestGateway({ cliLatest: latest });
    otherId = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other-settings@localhost", "Other")));
    other = new GatewayCore({ runtime: gw.runtime, userId: otherId, instanceId: "other-settings", cliLatest: latest });
  }, 60_000);
  afterAll(async () => {
    registry.stop(true);
    other?.secrets.stop();
    await gw?.close();
  });

  test("follow-up delivery persists across cores and stays scoped to the viewing user", async () => {
    const before = (await gw.api.getSettings({})).user!;

    const saved = (
      await gw.api.updateUserSettings({
        expectedVersion: before.version,
        composer: { runningDelivery: ui.MessageDelivery.QUEUE },
      })
    ).settings!;

    const restarted = new GatewayCore({ runtime: gw.runtime, userId: gw.userId, instanceId: "restart-delivery" });

    try {
      expect((await restarted.settings()).user?.composer?.runningDelivery).toBe(ui.MessageDelivery.QUEUE);
      expect((await other.settings()).user?.composer?.runningDelivery).toBe(ui.MessageDelivery.UNSPECIFIED);
      expect((await gw.api.getSettings({})).user?.threadDefaults).toEqual(before.threadDefaults);

      await gw.api.updateUserSettings({
        expectedVersion: saved.version,
        composer: { runningDelivery: ui.MessageDelivery.STEER },
      });
      expect((await restarted.settings()).user?.composer?.runningDelivery).toBe(ui.MessageDelivery.STEER);
      expect((await other.settings()).user?.composer?.runningDelivery).toBe(ui.MessageDelivery.UNSPECIFIED);
    } finally {
      restarted.secrets.stop();
    }
  });

  test("general and sidebar sections survive a new core, reject stale writes, isolate owners and reset without losing pins", async () => {
    const before = (await gw.api.getSettings({})).user!;

    const saved = (
      await gw.api.updateUserSettings({
        expectedVersion: before.version,
        general: { confirmArchive: true, confirmDelete: false, confirmUnpin: true },
        sidebar: { groupByProject: true, projectOrder: ui.ProjectOrder.NAME, workingSection: true },
      })
    ).settings!;

    expect(saved.general).toMatchObject({ confirmArchive: true, confirmDelete: false, confirmUnpin: true });
    expect(await failure(gw.api.updateUserSettings({ expectedVersion: before.version, general: {} }))).toContain(
      "changed",
    );
    expect(
      await failure(
        gw.api.updateUserSettings(
          fromJson(ui.UpdateUserSettingsRequestSchema, {
            expectedVersion: String(saved.version),
            sidebar: { projectOrder: 99 },
          }),
        ),
      ),
    ).toContain("project order");
    const restarted = new GatewayCore({ runtime: gw.runtime, userId: gw.userId, instanceId: "restart-settings" });

    try {
      expect((await restarted.settings()).user?.general).toEqual(saved.general);
    } finally {
      restarted.secrets.stop();
    }

    expect((await other.settings()).user?.general?.confirmArchive).toBe(false);
    const reset = (await gw.api.updateUserSettings({ expectedVersion: saved.version, general: {} })).settings!;
    expect(reset.general?.confirmDelete).toBeUndefined();
    expect(reset.sidebar).toEqual(saved.sidebar);
  });

  test("CLI schedule controls actual latest lookups, Never, manual checks, durable timestamps and worker overrides", async () => {
    let current = (await gw.api.getSettings({})).user!;
    await gw.api.updateUserSettings({ expectedVersion: current.version, cliUpdates: { intervalMinutes: 0 } });
    await gw.core.cli.checks.tick();
    const start = requests;
    await gw.core.cli.checks.tick("", false, Date.now() + 8 * 86_400_000);
    expect(requests).toBe(start);
    let worker = (await gw.api.getOverview({})).workers.find((w) => w.id === gw.workerId)!;
    expect(worker.effectiveCliUpdateCheckMinutes).toBe(0);
    expect(worker.cliUpdatesNextCheckAt).toBeUndefined();
    const result = await gw.api.checkCliUpdates({ workerId: gw.workerId });
    expect(result.latest.every((p) => p.version === "2.0.0")).toBe(true);
    expect(requests).toBe(start + 3);
    worker = (await gw.api.getOverview({})).workers.find((w) => w.id === gw.workerId)!;
    expect(worker.cliUpdatesCheckedAt).toBeDefined();
    await gw.api.setWorkerCliUpdateSettings({
      workerId: worker.id,
      expectedConfigVersion: worker.configVersion,
      intervalMinutes: 60,
    });
    await eventually(
      () => Promise.resolve(gw.worker.configs.at(-1)),
      (c) => c?.cliUpdateCheckMinutes === 60 && c.version === worker.configVersion + 1n,
    );
    const checked = Number(worker.cliUpdatesCheckedAt!.seconds) * 1000 + worker.cliUpdatesCheckedAt!.nanos / 1e6;
    await gw.core.cli.checks.tick(worker.id, false, checked + 59 * 60_000);
    expect(requests).toBe(start + 3);
    await gw.core.cli.checks.tick(worker.id, false, checked + 60 * 60_000);
    expect(requests).toBe(start + 6);
    current = (await gw.api.getSettings({})).user!;
    await gw.api.updateUserSettings({ expectedVersion: current.version, cliUpdates: { intervalMinutes: 1440 } });
    worker = (await gw.api.getOverview({})).workers.find((w) => w.id === gw.workerId)!;
    expect(worker.effectiveCliUpdateCheckMinutes).toBe(60);
    await gw.api.setWorkerCliUpdateSettings({ workerId: worker.id, expectedConfigVersion: worker.configVersion });
    await eventually(
      () => Promise.resolve(gw.worker.configs.at(-1)),
      (c) => c?.cliUpdateCheckMinutes === 1440,
    );
    const restarted = new GatewayCore({ runtime: gw.runtime, userId: gw.userId, instanceId: "restart-cli-settings" });

    try {
      const own = (await restarted.overview()).workers.find((w) => w.id === gw.workerId)!;
      expect(own.cliUpdatesCheckedAt).toBeDefined();
      expect(own.effectiveCliUpdateCheckMinutes).toBe(1440);
    } finally {
      restarted.secrets.stop();
    }
  });

  test("CLI validation and owner scoping cover config writes and latest lookups", async () => {
    const worker = (await gw.api.getOverview({})).workers.find((w) => w.id === gw.workerId)!;

    const request = create(ui.SetWorkerCliUpdateSettingsRequestSchema, {
      workerId: worker.id,
      expectedConfigVersion: worker.configVersion,
      intervalMinutes: 60,
    });

    expect(await failure(other.setWorkerCliUpdateSettings(request))).toContain("worker not found");
    expect(await failure(other.cli.checks.tick(worker.id, true))).toContain("worker not found");

    const otherWorker = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.addWorker({ name: "Other", ownerUserId: otherId })),
    );

    expect((await gw.api.getOverview({})).workers.some((w) => w.id === otherWorker.workerId)).toBe(false);
    const version = (await gw.api.getSettings({})).user!.version;
    expect(
      await failure(gw.api.updateUserSettings({ expectedVersion: version, cliUpdates: { intervalMinutes: 17 } })),
    ).toContain("interval");
    expect(await failure(gw.api.setWorkerCliUpdateSettings({ ...request, intervalMinutes: 17 }))).toContain("interval");
    expect((await gw.runtime.runPromise(SettingsStore.use((s) => s.user(otherId)))).version).toBe(0n);
  });

  test("a phone's overview snapshot carries its owner's settings, and later changes arrive as events", async () => {
    const initial = (await gw.api.getSettings({})).user!;

    const before = (
      await gw.api.updateUserSettings({ expectedVersion: initial.version, cliUpdates: { intervalMinutes: 60 } })
    ).settings!;

    const otherVersion = (await other.settings()).user?.version;
    const abort = new AbortController();
    const stream = gw.api.watchOverview({ includeSnapshot: true }, { signal: abort.signal });
    const updates = stream[Symbol.asyncIterator]();
    let snapshot: ui.MobileOverviewSnapshot | undefined;

    while (!snapshot) {
      const next = (await updates.next()).value!;

      if (next.change.case === "mobileSnapshot") snapshot = next.change.value;
    }

    expect(snapshot.settings?.user?.version).toBe(before.version);
    expect(snapshot.settings?.attachmentLimits).toBeDefined();
    const otherAbort = new AbortController();
    const otherStream = other.watchOverview(otherAbort.signal, true);
    const otherSnapshot = (await otherStream.next()).value;
    otherAbort.abort();
    await otherStream.return(undefined);
    expect(otherSnapshot?.change.case).toBe("mobileSnapshot");

    if (otherSnapshot?.change.case === "mobileSnapshot")
      expect(otherSnapshot.change.value.settings?.user?.version).toBe(otherVersion!);
    expect(otherVersion).not.toBe(before.version);

    const saved = await gw.api.updateUserSettings({
      expectedVersion: before.version,
      cliUpdates: { intervalMinutes: 1440 },
    });

    let event: ui.UserSettings | undefined;

    while (!event) {
      const next = (await updates.next()).value!;

      if (next.change.case === "userSettings") event = next.change.value;
    }

    expect(event.version).toBe(saved.settings!.version);
    abort.abort();
  });

  test("notification sources exclude another owner's threads from snapshots and live fan-out", async () => {
    const project = (await gw.api.createProject({ name: "Private notification" })).project!;

    const workspace = (
      await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo" })
    ).workspace!;

    const thread = (
      await gw.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: 2,
        title: "Private title",
      })
    ).thread!;

    expect((await other.listThreads("", false, false)).some((t) => t.id === thread.id)).toBe(false);
    const abort = new AbortController();
    const stream = other.watchOverview(abort.signal, true);
    const snapshot = create(ui.OverviewUpdateSchema, (await stream.next()).value);
    expect(snapshot.change.case).toBe("mobileSnapshot");

    if (snapshot.change.case === "mobileSnapshot")
      expect(snapshot.change.value.threads.some((t) => t.id === thread.id)).toBe(false);
    await stream.next(); // network routes
    const pending = stream.next();
    gw.core.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "thread", value: thread } }));
    abort.abort();
    expect((await pending).done).toBe(true);
  });

  test("stalled registry checks do not block worker reports or subsequent command replies", async () => {
    const current = (await gw.api.getSettings({})).user!;
    await gw.api.updateUserSettings({ expectedVersion: current.version, cliUpdates: { intervalMinutes: 0 } });
    const project = (await gw.api.createProject({ name: "Registry outage" })).project!;

    const workspace = (
      await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo" })
    ).workspace!;

    const gate = Promise.withResolvers<void>();
    registryGate = gate.promise;
    const before = requests;
    const checking = gw.api.checkCliUpdates({ workerId: gw.workerId });

    try {
      await eventually(
        () => Promise.resolve(requests),
        (count) => count >= before + 3,
      );
      gw.worker.link.send({ case: "cliTools", value: { tools: [] } });

      const created = await gw.api.createThread(
        { projectId: project.id, workspaceId: workspace.id, provider: 2, title: "Works while registry is down" },
        { timeoutMs: 5000 },
      );

      const ready = await eventually(
        () => gw.api.getThread({ threadId: created.thread!.id }),
        (response) => response.thread?.status === "idle",
        5000,
      );

      expect(ready.thread?.status).toBe("idle");
    } finally {
      registryGate = undefined;
      gate.resolve();
      await checking;
    }
  });
});
