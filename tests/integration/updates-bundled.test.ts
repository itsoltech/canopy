import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@connectrpc/connect";
import { update } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { createGrpcClientTransport } from "@canopy/transport";
import { bulkUpdateSteps } from "@canopy/domain/release/update-plan";
import { updatesSnapshot } from "../../apps/gateway/src/updates/center-composition.ts";
import { failure, startTestGateway } from "./support/gateway.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const VERSION = "2.0.0-nightly.5";

/** The app's own worker reports desktop_bundled over WorkerLink; an external binary worker lags one release. */
async function fixture(role: "desktop" | "server") {
  const gateway = await startTestGateway({
    role,
    updates: {
      kind: role === "desktop" ? "desktop" : "binary",
      version: VERSION,
      source: { baseUrl: "https://releases.fixture", fetch: async () => Response.json([]) },
    },
    worker: { hello: { capabilities: ["desktop_bundled"] } },
  });

  cleanups.push(async () => {
    gateway.core.updateCenter.stop();
    gateway.core.updates.close();
    await gateway.close();
  });
  const external = await gateway.addWorker("build server");
  await gateway.connect(external.workerId, external.credential, "linux");
  const client = createClient(update.UpdateService, createGrpcClientTransport({ baseUrl: gateway.grpcUrl }));

  const check = (workerId: string, credential: string, installKind: string, version: string) =>
    client.check(
      { workerId, version, installKind, os: "linux", arch: "x64", minWorkerLinkProtocol: 1, workerLinkProtocol: 1 },
      { headers: { authorization: `Bearer ${credential}` } },
    );

  await check(gateway.workerId, gateway.workerCredential, "desktop", VERSION);
  await check(external.workerId, external.credential, "binary", "2.0.0-nightly.4");

  return { gateway, external: external.workerId };
}

const byId = (snapshot: Awaited<ReturnType<typeof updatesSnapshot>>, id: string) =>
  snapshot.workers.find((w) => w.workerId === id)!;

describe.skipIf(!dockerAvailable)("the desktop app's bundled gateway and worker in the updates snapshot", () => {
  test("desktop role: both are part of the app, left out of Update all; an external worker stays", async () => {
    const { gateway, external } = await fixture("desktop");
    await gateway.core.updates.start();
    const snapshot = await updatesSnapshot(gateway.core);

    expect(snapshot.gatewayBundled).toBe(true);
    // The build's channel, not a default the bundled gateway never chose.
    expect(snapshot.channel).toBe("nightly");
    expect(byId(snapshot, gateway.workerId)).toMatchObject({ bundled: true, installKind: "desktop" });
    // No "pair this desktop app" placeholder: local mode never opens desktop control.
    expect(byId(snapshot, gateway.workerId).desktop).toBeUndefined();
    expect(byId(snapshot, external)).toMatchObject({ bundled: false, installKind: "binary" });

    expect(bulkUpdateSteps(snapshot).map((s) => [s.kind, s.workerId])).toEqual([["worker", external]]);

    // The overview marks the app's own worker: only its threads' folders and files open on this computer.
    const workers = (await gateway.api.getOverview({})).workers;
    expect(workers.find((w) => w.id === gateway.workerId)?.desktopBundled).toBe(true);
    expect(workers.find((w) => w.id === external)?.desktopBundled).toBe(false);

    // The app's own setting chooses its channel; the bundled gateway refuses its own.
    expect(await failure(gateway.api.manageUpdates({ action: "channel", channel: "stable" }))).toContain(
      "updates with the Canopy app",
    );
  });

  test("server role: update reads stay available during startup and shutdown", async () => {
    const { gateway, external } = await fixture("server");
    const install = () => gateway.api.manageUpdates({ action: "canopy_update_all" });

    expect(await gateway.api.getUpdates({})).toMatchObject({
      gatewayState: "starting",
      gatewayVersion: VERSION,
      gatewayUpdateAvailable: false,
      availableVersion: "",
    });
    expect(await failure(install())).toContain("Gateway update control is starting");
    await gateway.core.updates.start();
    await gateway.core.updates.check();
    const snapshot = await gateway.api.getUpdates({});

    expect(snapshot.gatewayState).toBe("idle");
    expect(snapshot.gatewayBundled).toBe(false);
    expect(snapshot.channel).toBe("stable");
    expect(byId(snapshot, gateway.workerId).bundled).toBe(false);
    expect(byId(snapshot, gateway.workerId).desktop?.disabledReason).toContain("Pair this desktop app");
    expect(byId(snapshot, external).bundled).toBe(false);
    expect(bulkUpdateSteps(snapshot).map((s) => [s.kind, s.workerId])).toEqual([["worker", external]]);

    gateway.core.updates.beginShutdown();
    expect(await gateway.api.getUpdates({})).toMatchObject({
      gatewayState: "shutting_down",
      gatewayVersion: VERSION,
      gatewayUpdateAvailable: false,
      availableVersion: "",
    });
    expect(await failure(install())).toContain("Gateway update control is shutting down");
  });
});
