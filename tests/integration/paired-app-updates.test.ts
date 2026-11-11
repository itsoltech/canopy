import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { routedPinnedTransport } from "@canopy/transport";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { appCheckPause, homeAppComputer, MANUAL_APP_UPDATE } from "@canopy/domain/release/update-actions";
import { rateLimitMessage } from "@canopy/domain/release/http";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { MobileDeparture, plannedDeparture } from "../../apps/mobile/src/api/departure.ts";
import {
  bulkUpdatesAvailable,
  computerAction,
  updatesAvailable,
} from "../../apps/mobile/src/features/updates/model.ts";
import { computerUpdate } from "../../apps/web/src/lib/features/workers/computer-updates.ts";
import { LocalApp } from "./support/local-app.ts";
import { SERVICE_TOKEN, startTestGateway, eventually, type TestGateway } from "./support/gateway.ts";

const makeTemp = tempDirs();

async function errorCode(request: Promise<object>) {
  try {
    await request;

    return undefined;
  } catch (error) {
    return ConnectError.from(error).code;
  }
}

const until = async (read: () => Promise<boolean>) => expect(await eventually(read, Boolean, 10_000)).toBe(true);

const updates = (version: string) => ({
  kind: "source" as const,
  version,
  source: { baseUrl: "https://releases.fixture", fetch: async () => Response.json([]) },
});

describe.skipIf(!dockerAvailable)("paired client updates its gateway's own desktop app", () => {
  let gateway: TestGateway;
  let network: NetworkAccess;
  let unmount: () => void;
  let app: LocalApp;
  let phone: Client<typeof ui.GatewayService>;
  let token = "";
  let deviceId = "";
  let journal = "";

  const query = (text: string, params: string[]) =>
    gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<{ details: Record<string, string> }>(text, params);
      }),
    );

  async function openNetwork() {
    network = new NetworkAccess({
      store: new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey),
      host: "127.0.0.1",
    });
    gateway.core.network = network;
    unmount = mountMobileNetwork(gateway.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
  }

  const paired = () =>
    createClient(ui.GatewayService, routedPinnedTransport(gateway.core.mobile.networkRoutes(), token).transport);

  beforeAll(async () => {
    gateway = await startTestGateway({ role: "desktop", updates: updates("1.0.0") });
    await openNetwork();
    const invitation = await gateway.api.createMobilePairing({});

    const result = await createClient(
      ui.MobilePairingService,
      routedPinnedTransport(invitation.routes!).transport,
    ).exchangeMobilePairing({ code: invitation.code, name: "Test phone", platform: "ios" });

    token = result.deviceToken;
    deviceId = result.device!.id;
    phone = paired();
    journal = join(makeTemp("canopy-paired-app-"), "remote-update.json");
    app = new LocalApp(gateway, journal);
    await until(async () => (await phone.getUpdates({})).app?.connected === true);
  }, 60_000);

  afterAll(async () => {
    await app?.stop();
    gateway?.core.appControl.close();
    unmount?.();
    await network?.close();
    await gateway?.close();
  }, 20_000);

  test("phone and BFF see an actionable home app, while Update all still leaves it alone", async () => {
    const snapshot = await phone.getUpdates({});
    const home = homeAppComputer(snapshot)!;
    expect(snapshot.appUpdateSupported).toBe(true);
    expect(home.updates?.app).toMatchObject({ version: "1.0.0", availableVersion: "1.1.0", connected: true });
    expect(computerAction(home)).toEqual({ action: "app" });
    expect(computerUpdate(home)).toMatchObject({ status: "Available", actionable: true });
    expect(updatesAvailable(snapshot)).toBe(true);
    expect(bulkUpdatesAvailable(snapshot)).toBe(false);
    expect((await gateway.api.getUpdates({})).app).toEqual(snapshot.app);
  });

  test("confirmation is required and force, downgrade and target overrides are refused before dispatch", async () => {
    expect(await errorCode(phone.manageUpdates({ action: "app" }))).toBe(Code.FailedPrecondition);

    for (const extra of [
      { force: true },
      { allowDowngrade: true },
      { nodeId: "other" },
      { workerId: gateway.workerId },
    ])
      expect(await errorCode(phone.manageUpdates({ action: "app", confirmRestart: true, ...extra }))).toBe(
        Code.InvalidArgument,
      );
    expect(app.checks).toBe(0);
    expect(app.restarts).toBe(0);
    expect((await phone.getUpdates({})).app?.requestId).toBe("");
  });

  test("a phone cannot impersonate the desktop control channel or use another owner's token", async () => {
    const other = await gateway.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("other-updater@test.invalid", "Other")),
    );

    await query("UPDATE mobile_devices SET owner_user_id = $1::uuid WHERE id = $2::uuid", [other, deviceId]);
    expect(await errorCode(phone.manageUpdates({ action: "app", confirmRestart: true }))).toBe(Code.Unauthenticated);
    await query("UPDATE mobile_devices SET owner_user_id = $1::uuid WHERE id = $2::uuid", [gateway.userId, deviceId]);
    expect(await errorCode(phone.reportAppControl({ sessionId: "fake", state: { phase: "succeeded" } }))).toBe(
      Code.PermissionDenied,
    );

    const stream = phone
      .watchAppControl({ workerId: gateway.workerId, version: "1.0.0", channel: "nightly", remoteUpdate: true })
      [Symbol.asyncIterator]();

    expect(await errorCode(stream.next())).toBe(Code.PermissionDenied);
    expect(app.checks).toBe(0);
  });

  test("older desktops and disabled updaters have a readable refusal, without a hidden update action", async () => {
    await app.stop();
    await until(async () => !(await phone.getUpdates({})).app?.connected);
    const disconnected = homeAppComputer(await phone.getUpdates({}))!;
    expect(disconnected.remoteUpdate).toBe(true);
    expect(computerUpdate(disconnected)).toMatchObject({ status: "Unavailable", actionable: false });
    expect(await errorCode(phone.manageUpdates({ action: "app", confirmRestart: true }))).toBe(Code.FailedPrecondition);
    const abort = new AbortController();

    const stream = gateway.api
      .watchAppControl({ workerId: gateway.workerId, version: "1.0.0", channel: "nightly" }, { signal: abort.signal })
      [Symbol.asyncIterator]();

    try {
      const opened = (await stream.next()).value!;
      await gateway.api.reportAppControl({
        sessionId: opened.sessionId,
        state: { workerId: gateway.workerId, version: "1.0.0", channel: "nightly", phase: "idle" },
      });
      const snapshot = await phone.getUpdates({});
      expect(snapshot.appUpdateSupported).toBe(false);
      expect(homeAppComputer(snapshot)?.reason).toBe(MANUAL_APP_UPDATE);
      expect(computerAction(homeAppComputer(snapshot)!)).toBeUndefined();
      expect(computerUpdate(homeAppComputer(snapshot)!)).toMatchObject({ status: "Manual update", actionable: false });
      expect(await errorCode(phone.manageUpdates({ action: "app", confirmRestart: true }))).toBe(
        Code.FailedPrecondition,
      );
    } finally {
      abort.abort();
      await stream.return?.();
    }

    app = new LocalApp(gateway, journal);
    await until(async () => (await phone.getUpdates({})).appUpdateSupported);
    app.status = {
      ...app.status,
      phase: "disabled",
      message: "Install Canopy for the current user to enable updates.",
    };
    await app.coordinator.publish();
    const disabled = homeAppComputer(await phone.getUpdates({}))!;
    expect(disabled.updates?.app?.disabledReason).toContain("current user");
    expect(computerAction(disabled)).toBeUndefined();
    expect(await errorCode(phone.manageUpdates({ action: "app", confirmRestart: true }))).toBe(Code.FailedPrecondition);
    app.status = { ...app.status, phase: "idle", message: "Update available" };
    await app.coordinator.publish();
  }, 15_000);

  test("reports preserve paused checks and failures such as administrator access", async () => {
    app.status = {
      ...app.status,
      phase: "idle",
      retryAt: Date.now() + 60_000,
      message: rateLimitMessage(Date.now() + 60_000),
    };
    await app.coordinator.publish();
    const paused = homeAppComputer(await phone.getUpdates({}))!;
    expect(appCheckPause(paused.updates?.app)).toContain("limiting update checks");
    expect(computerUpdate(paused)).toMatchObject({ status: "Checks paused", failed: false, actionable: false });
    app.status = {
      ...app.status,
      phase: "error",
      retryAt: undefined,
      error: "Administrator access is required. Update Canopy on that computer.",
    };
    await app.coordinator.publish();
    expect(computerUpdate(homeAppComputer(await phone.getUpdates({}))!)).toMatchObject({
      status: "Failed",
      detail: app.status.error,
    });
    app.status = { ...app.status, phase: "idle", error: undefined, message: "Update available" };
    await app.coordinator.publish();
  });

  test("a confirmed request reports checking, download receipts and waiting for idle; retries reuse the request", async () => {
    const announced = (async () => {
      for await (const event of phone.watchOverview({ includeSnapshot: true }, { signal: AbortSignal.timeout(10_000) }))
        if (event.change.case === "updatesChanged") return true;

      return false;
    })();

    const receipt = await phone.manageUpdates({ action: "app", confirmRestart: true });
    const requestId = receipt.app!.requestId;
    expect(requestId).not.toBe("");
    expect(await announced).toBe(true);
    await until(async () => (await phone.getUpdates({})).app?.phase === "checking");
    expect(app.restarts).toBe(0);
    app.advance();
    await until(async () => (await phone.getUpdates({})).app?.progress === 42);
    expect((await phone.getUpdates({})).app).toMatchObject({ phase: "downloading", targetVersion: "1.1.0", requestId });
    app.advance();
    await until(async () => (await phone.getUpdates({})).app?.phase === "waiting_idle");
    expect((await gateway.api.manageUpdates({ action: "app", confirmRestart: true })).app?.requestId).toBe(requestId);
    expect(app.checks).toBe(1);
    expect(app.restarts).toBe(0);
    const audit = await query("SELECT details FROM audit_log WHERE action = 'desktop.update.request'", []);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.["details"]).toMatchObject({ requestId, device: deviceId });
  }, 20_000);

  test("idle restart announces the outage and the same phone reconnects after gateway replacement", async () => {
    const departure = new MobileDeparture(undefined, () => {});

    const announced = (async () => {
      for await (const event of phone.watchOverview({ includeSnapshot: true }, { signal: AbortSignal.timeout(10_000) }))
        if (event.change.case === "gatewayDeparture" && event.change.value.state === "restarting")
          return event.change.value;
      throw new Error("No planned restart received");
    })();

    app.idle = true;
    departure.receive(await announced);
    expect(plannedDeparture(departure.snapshot())).toBe(true);
    await until(async () => app.restarts === 1);
    const requestId = (await phone.getUpdates({})).app!.requestId;
    await app.stop();
    gateway.core.appControl.close();
    unmount();
    await network.close();

    const storage = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    await gateway.close(true);
    gateway = await startTestGateway({ role: "desktop", storage, updates: updates("1.1.0") });
    await openNetwork();
    phone = paired();
    app = new LocalApp(gateway, journal, "1.1.0", "1.1.0");
    await until(async () => (await phone.getUpdates({})).app?.phase === "succeeded");
    const recovered = await phone.getUpdates({});
    expect(recovered.app).toMatchObject({ requestId, version: "1.1.0", phase: "succeeded" });
    departure.reconcile(recovered);
    expect(departure.snapshot()?.state).toBe("succeeded");
    expect(app.checks).toBe(0);
    const audit = await query("SELECT details FROM audit_log WHERE action = 'desktop.update.outcome'", []);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.["details"]).toMatchObject({ requestId, outcome: "succeeded" });
  }, 30_000);
});
