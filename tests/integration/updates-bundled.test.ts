import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@connectrpc/connect";
import { update } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { createGrpcClientTransport } from "@canopy/transport";
import { updatePlan } from "../../apps/gateway/src/updates/center-plan.ts";
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
  await gateway.core.updates.start();
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
    const snapshot = await updatesSnapshot(gateway.core);

    expect(snapshot.gatewayBundled).toBe(true);
    // The build's channel, not a default the bundled gateway never chose.
    expect(snapshot.channel).toBe("nightly");
    expect(byId(snapshot, gateway.workerId)).toMatchObject({ bundled: true, installKind: "desktop" });
    // No "pair this desktop app" placeholder: local mode never opens desktop control.
    expect(byId(snapshot, gateway.workerId).desktop).toBeUndefined();
    expect(byId(snapshot, external)).toMatchObject({ bundled: false, installKind: "binary" });

    expect(updatePlan(snapshot).steps.map((s) => [s.kind, s.workerId])).toEqual([["worker", external]]);

    // The app's own setting chooses its channel; the bundled gateway refuses its own.
    expect(await failure(gateway.api.manageUpdates({ action: "channel", channel: "stable" }))).toContain(
      "updates with the Canopy app",
    );
  });

  test("server role: the capability changes nothing", async () => {
    const { gateway, external } = await fixture("server");
    const snapshot = await updatesSnapshot(gateway.core);

    expect(snapshot.gatewayBundled).toBe(false);
    expect(snapshot.channel).toBe("stable");
    expect(byId(snapshot, gateway.workerId).bundled).toBe(false);
    expect(byId(snapshot, gateway.workerId).desktop?.disabledReason).toContain("Pair this desktop app");
    expect(byId(snapshot, external).bundled).toBe(false);
    expect(updatePlan(snapshot).steps.map((s) => [s.kind, s.workerId])).toEqual([["worker", external]]);
  });
});
