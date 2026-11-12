import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDirs } from "@canopy/testing";
import { routedPinnedTransport } from "@canopy/transport";
import type { DesktopUpdateStatus } from "@canopy/ui/desktop";
import { Effect } from "effect";
import { SqlClient, type SqlConnection } from "effect/sql";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { pairDesktop } from "../../apps/desktop/src/remote-client.ts";
import { RemoteDesktopControl } from "../../apps/desktop/src/remote-control.ts";
import { RemoteAppUpdate } from "../../apps/desktop/src/remote-app-update.ts";
import { DesktopUpdateStore } from "../../apps/gateway/src/desktop-updates/store.ts";
import { UpdateRunStore } from "../../apps/gateway/src/updates/run-store.ts";
import { SERVICE_TOKEN, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

const makeTemp = tempDirs();

async function until(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await Bun.sleep(25);
  }

  throw new Error("Desktop update did not reach the expected state");
}

describe.skipIf(!dockerAvailable)("gateway ↔ desktop app updates over pinned TLS", () => {
  let gw: TestGateway;
  let network: NetworkAccess;
  let unmount: () => void;
  const controls: RemoteDesktopControl[] = [];
  const coordinators: RemoteAppUpdate[] = [];
  const loops: Promise<void>[] = [];

  const query = (text: string, params: unknown[] = []) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<SqlConnection.Row>(text, params);
      }),
    );

  const state = async (workerId: string) => {
    return (await gw.api.getUpdates({})).workers.find((w) => w.workerId === workerId)?.desktop;
  };

  const manage = (workerId: string, force = false, desktopRequestId = "") =>
    gw.api.manageUpdates({ action: "desktop", workerId, force, desktopRequestId });

  async function openNetwork() {
    network = new NetworkAccess({ store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey), host: "127.0.0.1" });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
  }

  beforeAll(async () => {
    gw = await startTestGateway();
    await openNetwork();
  }, 60_000);
  afterAll(async () => {
    for (const coordinator of coordinators) coordinator.stop();

    for (const control of controls) control.stop();
    await Promise.all(loops);
    gw?.core.desktopControl.close();
    unmount?.();
    await network?.close();
    await gw?.close();
  });

  async function fixture() {
    const worker = await gw.addWorker("Canopy desktop");
    await query(
      "UPDATE workers SET capabilities = jsonb_set(capabilities, '{update}', '{\"installKind\":\"desktop\"}') WHERE id = $1",
      [worker.workerId],
    );

    let client = await pairDesktop(
      toJsonString(ui.CreateMobilePairingResponseSchema, await gw.api.createDesktopPairing({})),
    );

    const directory = makeTemp("canopy-desktop-control-");
    writeFileSync(
      join(directory, "worker.json"),
      JSON.stringify({ worker_id: worker.workerId, credential: worker.credential }),
      { mode: 0o600 },
    );

    let status: DesktopUpdateStatus = {
      version: "1.0.0",
      channel: "beta",
      buildChannel: "beta",
      phase: "idle",
      message: "Ready",
      changingChannel: false,
    };

    let idle = false;
    let restarts = 0;
    let notifications = 0;
    let checks = 0;
    let result: "signed" | "unsigned" | "older" | "current" = "signed";
    let releaseDownload: (() => void) | undefined;
    let control: RemoteDesktopControl;
    let coordinator: RemoteAppUpdate;
    const reports: ui.DesktopUpdateState[] = [];

    const boundary = {
      status: () => status,
      check: async () => {
        checks++;
        status = { ...status, phase: "downloading", progress: 42, updateVersion: "1.1.0-beta.1" };
        coordinator.changed();

        if (result === "signed")
          await new Promise<void>((resolve) => {
            releaseDownload = resolve;
          });

        if (result === "current")
          status = {
            ...status,
            phase: "idle",
            message: "Up to date",
            updateVersion: undefined,
            lastCheckedAt: Date.now(),
          };
        else if (result === "unsigned")
          status = { ...status, phase: "error", message: "Update rejected: Developer ID signature is missing." };
        else status = { ...status, phase: "downloaded", updateVersion: result === "older" ? "0.9.0" : "1.1.0-beta.1" };

        return status;
      },
      drain: async (_value: boolean) => idle,
      notify: () => {
        notifications++;
      },
      prepareRestart: async () => status,
      restart: () => {
        restarts++;
        control.stop();
      },
      report: async (value: ui.DesktopUpdateState) => {
        reports.push(value);
        await control.report(toJsonString(ui.DesktopUpdateStateSchema, value));
      },
    };

    const connect = async () => {
      coordinator = new RemoteAppUpdate(join(directory, "update.json"), boundary);
      coordinator.selectDevice(client.deviceId);
      coordinators.push(coordinator);
      control = new RemoteDesktopControl(client, directory, (command) => {
        void coordinator.command(command);
      });
      controls.push(control);
      await coordinator.publish();
      loops.push(control.run());
      await until(async () => !!gw.core.desktopControl.sessions.get(client.deviceId)?.confirmed);
      await until(async () => (await state(worker.workerId))?.version === status.version);
    };

    await connect();

    return {
      workerId: worker.workerId,
      get client() {
        return client;
      },
      reports,
      counts: () => ({ checks, restarts, notifications }),
      result: (value: typeof result) => {
        result = value;
      },
      idle: () => {
        idle = true;
      },
      downloaded: () => releaseDownload?.(),
      stage: (version: string) => {
        status = { ...status, phase: "downloaded", updateVersion: version };
      },
      stop: () => {
        coordinator.stop();
        control.stop();
      },
      corruptHistory: () => {
        const path = join(directory, `update.json.${createHash("sha256").update(client.deviceId).digest("hex")}`);
        writeFileSync(path, "unreadable", { mode: 0o600 });

        return () => readFileSync(path, "utf8");
      },
      pairAgain: async () => {
        control.stop();
        client = await pairDesktop(
          toJsonString(ui.CreateMobilePairingResponseSchema, await gw.api.createDesktopPairing({})),
        );
        await connect();
      },
      reconnect: async (version = status.version, updateVersion = status.updateVersion) => {
        coordinator.stop();
        control.stop();
        client = { ...client, addresses: gw.core.mobile.networkRoutes().addresses };
        status = { ...status, version, updateVersion, phase: "idle" };
        await connect();
      },
    };
  }

  test("request, progress, deduplication, idle wait, restart/reconnect and durable owner audit", async () => {
    const app = await fixture();
    await manage(app.workerId);
    await until(async () => (await state(app.workerId))?.phase === "downloading");
    expect((await state(app.workerId))?.progress).toBe(42);
    await manage(app.workerId);
    expect(app.counts()).toEqual({ checks: 1, restarts: 0, notifications: 1 });
    app.downloaded();
    await until(async () => (await state(app.workerId))?.phase === "waiting_idle");
    expect(app.counts().restarts).toBe(0);
    const requestId = (await state(app.workerId))!.requestId;
    app.idle();
    await until(async () => app.counts().restarts === 1);
    await app.reconnect("1.1.0-beta.1", "1.2.0-beta.1");
    await until(async () => (await state(app.workerId))?.phase === "succeeded");
    expect((await state(app.workerId))?.requestId).toBe(requestId);
    expect((await state(app.workerId))?.availableVersion).toBe("1.2.0-beta.1");
    expect((await state(app.workerId))?.targetVersion).toBe("1.1.0-beta.1");
    expect(app.counts().checks).toBe(1);

    const audit = await query(
      "SELECT actor_user_id, action, details FROM audit_log WHERE target_id = $1 AND action LIKE 'desktop.update.%' ORDER BY created_at",
      [app.workerId],
    );

    expect(audit.map((row) => row["action"])).toEqual(["desktop.update.request", "desktop.update.outcome"]);
    expect(audit.every((row) => row["actor_user_id"] === gw.userId)).toBe(true);
    expect(JSON.stringify(audit)).toContain("1.1.0-beta.1");
    expect(JSON.stringify(audit)).not.toContain("1.2.0-beta.1");
  }, 20_000);

  test("force is an explicit audited action tied to the waiting request", async () => {
    const app = await fixture();
    await manage(app.workerId);
    await until(async () => app.counts().checks === 1);
    app.downloaded();
    await until(async () => (await state(app.workerId))?.phase === "waiting_idle");
    expect(await failure(manage(app.workerId, true, crypto.randomUUID()))).toContain("match");
    await manage(app.workerId, true, (await state(app.workerId))!.requestId);
    await until(async () => app.counts().restarts === 1);
    expect(
      (
        await query("SELECT action FROM audit_log WHERE target_id = $1 AND action = 'desktop.update.force'", [
          app.workerId,
        ])
      ).length,
    ).toBe(1);
  }, 15_000);

  test("a newer ready build while waiting for idle becomes the persisted restart target", async () => {
    const app = await fixture();
    await manage(app.workerId);
    await until(async () => app.counts().checks === 1);
    app.downloaded();
    await until(async () => (await state(app.workerId))?.phase === "waiting_idle");
    app.stage("1.2.0-beta.1");
    app.idle();
    await until(async () => app.counts().restarts === 1);
    await app.reconnect("1.2.0-beta.1");
    await until(async () => (await state(app.workerId))?.phase === "succeeded");
    expect((await state(app.workerId))?.targetVersion).toBe("1.2.0-beta.1");
  }, 20_000);

  test("unsigned and older releases fail without a restart or changing the desktop channel", async () => {
    for (const result of ["unsigned", "older"] as const) {
      const app = await fixture();
      app.result(result);
      await manage(app.workerId);
      await until(async () => (await state(app.workerId))?.phase === "failed");
      expect((await state(app.workerId))?.reason).toContain(result === "unsigned" ? "signature" : "strictly newer");
      expect((await state(app.workerId))?.channel).toBe("beta");
      expect(app.counts().restarts).toBe(0);
      expect(
        JSON.stringify(
          await query("SELECT details FROM audit_log WHERE target_id = $1 AND action = 'desktop.update.outcome'", [
            app.workerId,
          ]),
        ),
      ).toContain("failed");
    }
  }, 15_000);

  test("offline, unpaired, unsupported, foreign owner and revoked desktops cannot be updated", async () => {
    const app = await fixture();
    app.stop();
    await until(async () => !(await state(app.workerId))?.connected);
    expect((await state(app.workerId))?.disabledReason).toContain("offline");
    expect(await failure(manage(app.workerId))).toContain("offline");
    expect(await failure(manage(gw.workerId))).toContain("Pair");
    await app.reconnect();
    const session = gw.core.desktopControl.sessions.get(app.client.deviceId)!;
    session.hello.remoteUpdate = false;
    expect((await state(app.workerId))?.disabledReason).toContain("manually");
    expect(await failure(manage(app.workerId))).toContain("manually");
    session.hello.remoteUpdate = true;
    const other = Bun.randomUUIDv7();
    await query("INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'Other', 'user')", [
      other,
      `${other}@test.invalid`,
    ]);
    await query("UPDATE workers SET owner_user_id = $1 WHERE id = $2", [other, app.workerId]);
    expect(await failure(manage(app.workerId))).toContain("Pair");
    await query("UPDATE workers SET owner_user_id = $1 WHERE id = $2", [gw.userId, app.workerId]);
    await gw.api.revokeMobileDevice({ id: app.client.deviceId });
    await until(async () => !gw.core.desktopControl.sessions.has(app.client.deviceId));
    expect(await failure(manage(app.workerId))).toContain("Pair");
  }, 15_000);

  test("desktop stream cannot bind an id without the worker's separate owner credential", async () => {
    const app = await fixture();
    const session = gw.core.desktopControl.sessions.get(app.client.deviceId)!;

    const proof = createClient(
      ui.DesktopWorkerService,
      routedPinnedTransport(gw.core.mobile.networkRoutes(), app.client.token).transport,
    );

    expect(await failure(proof.confirm({ deviceId: app.client.deviceId, sessionId: session.id }))).toContain("proof");
    expect(
      await failure(gw.api.manageUpdates({ action: "desktop", workerId: app.workerId, allowDowngrade: true })),
    ).toContain("forbidden");
  }, 15_000);

  test("re-pairing after revocation clears the old command without replaying it", async () => {
    const app = await fixture();
    app.result("older");
    await manage(app.workerId);
    await until(async () => (await state(app.workerId))?.phase === "failed");
    const previous = (await state(app.workerId))!.requestId;
    await gw.api.revokeMobileDevice({ id: app.client.deviceId });
    await app.pairAgain();
    await until(async () => (await state(app.workerId))?.phase === "idle");
    expect((await state(app.workerId))?.requestId).toBe("");
    expect(app.counts().checks).toBe(1);
    await manage(app.workerId);
    await until(async () => (await state(app.workerId))?.phase === "failed");
    expect((await state(app.workerId))?.requestId).not.toBe(previous);
    expect(app.counts().checks).toBe(2);
  }, 15_000);

  test("unreadable local history keeps the app connected but disables remote replay", async () => {
    const app = await fixture();
    app.result("older");
    await manage(app.workerId);
    await until(async () => (await state(app.workerId))?.phase === "failed");
    app.stop();
    await until(async () => !(await state(app.workerId))?.connected);
    const history = app.corruptHistory();
    await app.reconnect();
    await until(async () => !!(await state(app.workerId))?.disabledReason.includes("history"));
    expect(await failure(manage(app.workerId))).toContain("history");
    expect(app.counts().checks).toBe(1);
    expect(history()).toBe("unreadable");
  }, 15_000);

  test("requesting again when the target is current succeeds without a restart", async () => {
    const app = await fixture();
    app.result("unsigned");
    await manage(app.workerId);
    await until(async () => (await state(app.workerId))?.phase === "failed");
    const previous = (await state(app.workerId))!.requestId;
    app.result("current");
    await manage(app.workerId);
    await until(async () => (await state(app.workerId))?.phase === "succeeded");
    expect((await state(app.workerId))?.requestId).not.toBe(previous);
    expect((await state(app.workerId))?.reason).toBe("");
    expect(app.counts()).toEqual({ checks: 2, notifications: 2, restarts: 0 });
    await app.reconnect();
    expect((await state(app.workerId))?.phase).toBe("succeeded");
  }, 20_000);

  test("dismiss is tied to the failed request and its owner, and survives desktop reconnect", async () => {
    const app = await fixture();
    app.result("unsigned");
    await manage(app.workerId);
    await until(async () => (await state(app.workerId))?.phase === "failed");
    const requestId = (await state(app.workerId))!.requestId;

    const dismiss = () =>
      gw.api.manageUpdates({ action: "desktop_dismiss", workerId: app.workerId, desktopRequestId: requestId });

    expect(
      await failure(
        gw.api.manageUpdates({
          action: "desktop_dismiss",
          workerId: app.workerId,
          desktopRequestId: crypto.randomUUID(),
        }),
      ),
    ).toContain("current failed");
    const other = Bun.randomUUIDv7();
    await query("INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'Other', 'user')", [
      other,
      `${other}@test.invalid`,
    ]);
    await query("UPDATE workers SET owner_user_id = $1 WHERE id = $2", [other, app.workerId]);
    expect(await failure(dismiss())).toContain("Pair");
    await query("UPDATE workers SET owner_user_id = $1 WHERE id = $2", [gw.userId, app.workerId]);
    await dismiss();
    await until(async () => app.reports.at(-1)?.phase === "idle");
    await app.reconnect();
    expect(await state(app.workerId)).toMatchObject({ phase: "idle", reason: "", requestId });
    expect(app.counts().checks).toBe(1);

    await manage(app.workerId);
    await until(async () => (await state(app.workerId))?.phase === "failed");
    const nextRequest = (await state(app.workerId))!.requestId;
    const store = new UpdateRunStore(gw.runtime, gw.userId);

    const run = create(ui.UpdateRunSchema, {
      id: crypto.randomUUID(),
      state: "failed",
      steps: [{ kind: "desktop", workerId: app.workerId, requestId: nextRequest, state: "failed", version: "1.1.0" }],
    });

    await store.write(run);
    await gw.api.manageUpdates({ action: "dismiss_run", desktopRequestId: run.id });
    expect(await state(app.workerId)).toMatchObject({ phase: "idle", reason: "", requestId: nextRequest });
    expect(await store.read()).toMatchObject({ state: "dismissed", steps: [{ state: "dismissed" }] });
  }, 20_000);

  test("a restart on the old version fails; a later current version clears the durable row across gateway replacement", async () => {
    const app = await fixture();
    await manage(app.workerId);
    await until(async () => app.counts().checks === 1);
    app.downloaded();
    await until(async () => (await state(app.workerId))?.phase === "waiting_idle");
    await app.reconnect("1.0.0");
    await until(async () => (await state(app.workerId))?.phase === "failed");
    expect((await state(app.workerId))?.reason).toContain("restarted before");
    const requestId = (await state(app.workerId))!.requestId;
    await app.reconnect("1.2.0", "1.2.0");
    await until(async () => (await state(app.workerId))?.phase === "succeeded");
    expect(
      (await new DesktopUpdateStore(gw.runtime, gw.userId).list()).find((row) => row.workerId === app.workerId)?.state,
    ).toMatchObject({ requestId, phase: "succeeded", reason: "", version: "1.2.0", targetVersion: "1.1.0-beta.1" });

    for (const coordinator of coordinators) coordinator.stop();

    for (const control of controls) control.stop();
    await Promise.all(loops);
    unmount();
    await network.close();

    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    await gw.close(true);
    gw = await startTestGateway({ storage });
    await openNetwork();
    expect(await state(app.workerId)).toMatchObject({ requestId, phase: "succeeded", reason: "", connected: false });
    await app.reconnect("1.2.0", "1.2.0");
    expect(await state(app.workerId)).toMatchObject({ requestId, phase: "succeeded", reason: "", connected: true });
  }, 60_000);
});
