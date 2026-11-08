import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { serviceTokenAuth, uiRoutes, remoteServe, uiHandlers } from "@canopy/gateway/api";
import { startGrpcServer } from "@canopy/transport";
import { DEPARTURE_WINDOW_MS } from "@canopy/domain/computer-presence";
import { SERVICE_TOKEN, startTestGateway, eventually, type TestGateway } from "./support/gateway.ts";
import { linkedComputers } from "./support/computers.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const updates = (version: string) => ({
  kind: "source" as const,
  version,
  source: { baseUrl: "https://releases.fixture", fetch: async () => Response.json([]) },
});

async function departure(api: TestGateway["api"], state: string, signal: AbortSignal) {
  for await (const update of api.watchOverview({ includeSnapshot: true }, { signal }))
    if (update.change.case === "gatewayDeparture" && update.change.value.state === state) return update.change.value;
  throw new Error("Overview ended before the departure");
}

describe.skipIf(!dockerAvailable)("gateway planned departures", () => {
  test("linked presence carries the target and outcome to clients of the peer gateway", async () => {
    const a = await startTestGateway({ role: "desktop", updates: updates("1.0.0") });
    cleanups.push(() => a.close());
    const b = await startTestGateway({ role: "desktop", updates: updates("1.0.0") });
    cleanups.push(() => b.close());

    const link = (gateway: TestGateway) =>
      linkedComputers({
        store: new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey),
        host: "127.0.0.1",
        core: gateway.core,
        serve: remoteServe(uiHandlers(gateway.core), gateway.core),
        heartbeatMs: 100,
      });

    const la = link(a),
      lb = link(b);

    const links = [la, lb];
    a.core.computers = la;
    b.core.computers = lb;

    for (const linked of links) {
      cleanups.push(() => linked.close());
      await linked.start();
    }

    const invitation = await la!.createPairing();
    await lb!.pair(la!.addresses[0]!, invitation.code);
    expect(await eventually(async () => la.reachable().includes(lb.hello().nodeId), Boolean)).toBe(true);
    const signal = AbortSignal.timeout(10_000);
    const announced = departure(a.api, "updating", signal);
    await b.core.departures.announce("updating", "1.1.0");
    expect(await announced).toMatchObject({ nodeId: lb!.hello().nodeId, targetVersion: "1.1.0", state: "updating" });
    const result = departure(a.api, "failed", AbortSignal.timeout(5000));
    await b.core.departures.recover("failed", "The update could not be installed.");
    expect(await result).toMatchObject({
      nodeId: lb!.hello().nodeId,
      state: "failed",
      reason: "The update could not be installed.",
    });
  }, 60_000);

  test("all overview clients receive the announcement; its outcome survives a gateway replacement and is owner scoped", async () => {
    let gateway = await startTestGateway({ updates: updates("1.0.0") });
    cleanups.push(async () => {
      gateway.core.updates.close();
      await gateway.close();
    });
    await gateway.core.updates.start();
    const otherId = await gateway.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other@localhost", "Other")));

    const other = new GatewayCore({
      runtime: gateway.runtime,
      instanceId: "other",
      userId: otherId,
      updates: updates("1.0.0"),
    });

    const server = await startGrpcServer({
      routes: uiRoutes(other),
      host: "127.0.0.1",
      port: 0,
      interceptors: [serviceTokenAuth(SERVICE_TOKEN)],
    });

    cleanups.push(() => server.close());

    const otherApi = createClient(
      ui.GatewayService,
      createGrpcTransport({
        baseUrl: server.url,
        interceptors: [
          (next) => (request) => {
            request.header.set("authorization", `Bearer ${SERVICE_TOKEN}`);

            return next(request);
          },
        ],
      }),
    );

    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    const received = [departure(gateway.api, "updating", signal), departure(gateway.api, "updating", signal)];
    await gateway.core.departures.announce("updating", "1.1.0");
    const [first, second] = await Promise.all(received);
    expect(first).toMatchObject({
      state: "updating",
      targetVersion: "1.1.0",
      version: "1.0.0",
      windowMs: DEPARTURE_WINDOW_MS,
    });
    expect(second?.id).toBe(first?.id);
    expect(first!.startedAtMs > 0n).toBe(true);
    expect((await otherApi.getUpdates({})).departure).toBeUndefined();
    await gateway.core.departures.announce("restarting", "1.1.0");

    const storage = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    controller.abort();
    await server.close();
    cleanups.pop();
    cleanups.pop();
    gateway.core.updates.close();
    await gateway.close(true);
    gateway = await startTestGateway({ storage, updates: updates("1.1.0") });
    await gateway.core.updates.start();
    const result = await departure(gateway.api, "succeeded", AbortSignal.timeout(5000));
    expect(result).toMatchObject({ id: first!.id, version: "1.1.0", targetVersion: "1.1.0", reason: "" });
    expect((await gateway.api.getUpdates({})).departure).toEqual(result);
  }, 60_000);

  test("returning on the old version reports failure; rollback preserves the updater's reason", async () => {
    const gateway = await startTestGateway({ updates: updates("1.0.0") });
    cleanups.push(() => gateway.close());
    await gateway.core.departures.announce("restarting", "1.1.0");
    await gateway.core.departures.recover();
    expect((await gateway.api.getUpdates({})).departure).toMatchObject({ state: "failed", version: "1.0.0" });
    await gateway.core.departures.announce("restarting", "1.1.0");
    await gateway.core.departures.recover("rolled_back", "The new version did not become healthy.", "1.1.0");
    expect((await gateway.api.getUpdates({})).departure).toMatchObject({
      state: "rolled_back",
      reason: "The new version did not become healthy.",
    });
  }, 60_000);
});
