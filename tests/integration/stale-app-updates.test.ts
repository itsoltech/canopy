import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { LocalAppControl } from "../../apps/gateway/src/desktop-updates/local.ts";
import { AppUpdateDismissals } from "../../apps/gateway/src/desktop-updates/dismissals.ts";
import { UpdateRunStore } from "../../apps/gateway/src/updates/run-store.ts";
import { UpdateCenter } from "../../apps/gateway/src/updates/center.ts";
import { LocalApp } from "./support/local-app.ts";
import { eventually, failure, startTestGateway } from "./support/gateway.ts";

const makeTemp = tempDirs();
const cleanups: (() => Promise<void>)[] = [];

const updates = (version: string) => ({
  kind: "source" as const,
  version,
  source: { baseUrl: "https://releases.fixture", fetch: async () => Response.json([]) },
});

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(phase: string, version = "1.0.0") {
  let gateway = await startTestGateway({ role: "desktop", updates: updates(version) });
  let app: LocalApp | undefined;
  cleanups.push(async () => {
    await app?.stop();
    gateway.core.appControl.close();
    await gateway.close();
  });
  const journal = join(makeTemp("canopy-app-history-"), "remote-update.json");
  const requestId = crypto.randomUUID();
  writeFileSync(
    journal,
    toJsonString(
      ui.DesktopUpdateStateSchema,
      create(ui.DesktopUpdateStateSchema, {
        phase,
        requestId,
        version: "1.0.0",
        targetVersion: "1.1.0",
        availableVersion: "1.1.0",
        reason: phase === "failed" ? "The app restarted before the update completed. Request it again." : "",
      }),
    ),
  );

  const connect = async (nextVersion = version) => {
    await app?.stop();
    app = new LocalApp(gateway, journal, nextVersion, nextVersion === "1.0.0" ? "1.1.0" : nextVersion);
    expect(
      await eventually(
        async () => (await gateway.api.getUpdates({})).app?.version,
        (value) => value === nextVersion,
      ),
    ).toBe(nextVersion);
  };

  await connect();

  return {
    get gateway() {
      return gateway;
    },
    get app() {
      return app!;
    },
    requestId,
    journal,
    connect,
    history: () => fromJsonString(ui.DesktopUpdateStateSchema, readFileSync(journal, "utf8")),
    restart: async (nextVersion = version) => {
      await app?.stop();

      const storage = {
        pg: gateway.pg,
        secretsKey: gateway.secretsKey,
        workerId: gateway.workerId,
        workerCredential: gateway.workerCredential,
      };

      await gateway.close(true);
      gateway = await startTestGateway({ role: "desktop", storage, updates: updates(nextVersion) });
      await connect(nextVersion);
    },
  };
}

describe.skipIf(!dockerAvailable)("desktop request history through gateway gRPC", () => {
  for (const [phase, version] of [
    ["waiting_idle", "1.1.0"],
    ["restarting", "1.2.0"],
    ["failed", "1.1.0"],
  ] as const) {
    test(`a ${phase} journal is reconciled after starting ${version}`, async () => {
      const f = await fixture(phase, version);
      expect((await f.gateway.api.getUpdates({})).app).toMatchObject({
        phase: "succeeded",
        reason: "",
        version,
        requestId: f.requestId,
        targetVersion: "1.1.0",
      });
      expect(f.history().phase).toBe("succeeded");
      expect(f.app.checks).toBe(0);
      expect(f.app.restarts).toBe(0);
    }, 30_000);
  }

  test("returning on the old version stays failed until a completed check reports Up to date", async () => {
    const f = await fixture("restarting");
    expect((await f.gateway.api.getUpdates({})).app).toMatchObject({ phase: "failed", targetVersion: "1.1.0" });
    await f.restart();
    expect((await f.gateway.api.getUpdates({})).app?.phase).toBe("failed");
    f.app.status = {
      ...f.app.status,
      phase: "idle",
      message: "Up to date",
      updateVersion: undefined,
      lastCheckedAt: Date.now(),
    };
    await f.app.coordinator.publish();
    expect((await f.gateway.api.getUpdates({})).app).toMatchObject({
      phase: "succeeded",
      reason: "",
      updaterCurrent: true,
    });
    expect(f.history().phase).toBe("succeeded");
    await f.restart();
    expect((await f.gateway.api.getUpdates({})).app?.phase).toBe("succeeded");
  }, 60_000);

  test("dismissal is owner scoped, persisted before delivery and survives gateway and app restart", async () => {
    const f = await fixture("failed");

    const other = await f.gateway.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("other-dismiss@test.invalid", "Other")),
    );

    const foreign = new LocalAppControl(f.gateway.runtime, other);
    expect(await failure(foreign.dismiss(f.requestId))).toContain("current failed");
    expect((await f.gateway.api.getUpdates({})).app?.phase).toBe("failed");
    expect(
      await failure(f.gateway.api.manageUpdates({ action: "app_dismiss", desktopRequestId: crypto.randomUUID() })),
    ).toContain("current failed");
    // Existing preferences keep their optimistic revision when private acknowledgements change.
    const initial = (await f.gateway.api.getSettings({})).user!.version;
    await f.gateway.api.updateUserSettings({ expectedVersion: initial, timezone: "UTC" });
    const version = (await f.gateway.api.getSettings({})).user!.version;
    await f.app.stop();
    await f.gateway.api.manageUpdates({ action: "app_dismiss", desktopRequestId: f.requestId });
    expect(await new AppUpdateDismissals(f.gateway.runtime, other).read()).toBe("");
    expect(await new AppUpdateDismissals(f.gateway.runtime, f.gateway.userId).read()).toBe(f.requestId);
    await f.restart();
    expect(
      await eventually(
        async () => f.history().phase,
        (phase) => phase === "idle",
      ),
    ).toBe("idle");
    expect((await f.gateway.api.getUpdates({})).app).toMatchObject({
      phase: "idle",
      reason: "",
      requestId: f.requestId,
    });
    expect((await f.gateway.api.getSettings({})).user!.version).toBe(version);
    expect(f.app.checks).toBe(0);
  }, 60_000);

  test("dismissing a stopped run cannot read or change another owner's run", async () => {
    const f = await fixture("failed");

    const run = create(ui.UpdateRunSchema, {
      id: crypto.randomUUID(),
      state: "failed",
      reason: "App update failed",
      steps: [{ kind: "computer", nodeId: "a".repeat(64), requestId: f.requestId, version: "1.1.0", state: "failed" }],
    });

    const store = new UpdateRunStore(f.gateway.runtime, f.gateway.userId);
    await store.write(run);

    const other = await f.gateway.runtime.runPromise(
      GatewayStore.use((db) => db.ensureUser("other-run@test.invalid", "Other")),
    );

    const foreign = new UpdateRunStore(f.gateway.runtime, other);

    const foreignCenter = new UpdateCenter({
      ...f.gateway.core.updateCenter.options,
      read: () => foreign.read(),
      write: (value) => foreign.write(value),
    });

    expect(await foreign.read()).toBeUndefined();
    expect(await failure(foreignCenter.dismiss(run.id))).toContain("current stopped");
    expect(
      await failure(f.gateway.api.manageUpdates({ action: "dismiss_run", desktopRequestId: crypto.randomUUID() })),
    ).toContain("current stopped");
    await f.gateway.api.manageUpdates({ action: "dismiss_run", desktopRequestId: run.id });
    expect(await store.read()).toMatchObject({ id: run.id, state: "dismissed", reason: "" });
    expect(await foreign.read()).toBeUndefined();
    await f.restart();
    expect((await f.gateway.api.getUpdates({})).run).toMatchObject({ id: run.id, state: "dismissed", reason: "" });
  }, 60_000);
});
