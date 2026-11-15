import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { proxyCapacityGroups } from "@canopy/domain/proxy-capacity";
import { GatewayStore, InstanceStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ProxyAccountsMonitor } from "../../apps/gateway/src/core/proxy-accounts.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

const Plan = ui.ProxyAccountPlan;
let detected = "";
let present = true;
let email = "account@example.test";
let index = "initial-index";

const management = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () =>
    Response.json({
      files: present
        ? [
            {
              id: "claude-account.json",
              auth_index: index,
              provider: "claude",
              email,
              plan_type: detected,
              status: "active",
              quota: {
                observed_at: new Date().toISOString(),
                signals: {
                  "anthropic-ratelimit-unified-7d-utilization": "0.5",
                  "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 86400),
                },
              },
            },
          ]
        : [],
    }),
});

let gw: TestGateway;
let proxyId: string;

async function fresh() {
  await gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE proxies SET management_read_at = NULL WHERE id = ${proxyId}::uuid`;
    }),
  );

  return new ProxyAccountsMonitor(gw.core).refresh(proxyId, true);
}

describe.skipIf(!dockerAvailable)("manual proxy plans through the gateway", () => {
  beforeAll(async () => {
    gw = await startTestGateway();

    const saved = await gw.api.saveProxy({
      name: "Plans",
      kind: "cliproxyapi",
      baseUrl: `http://127.0.0.1:${management.port}`,
      managementKey: "fixture-management-key",
      secret: "fixture-inference-secret",
    });

    proxyId = saved.proxy!.id;
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    await management.stop(true);
  });

  test("setting, refresh, later detection, clearing, capacity and owner isolation", async () => {
    const initial = await gw.api.refreshProxyAccounts({ id: proxyId, force: true });
    const account = initial.accounts[0]!;
    const request = { proxyId, accountKey: account.planKey, plan: Plan.ULTRA };
    expect(account.plan).toBe(Plan.UNSPECIFIED);
    expect(proxyCapacityGroups(initial.accounts)[0]?.windows[0]?.total).toBe(1);

    const manual = await gw.api.setProxyAccountPlan(request);
    expect(manual.accounts[0]).toMatchObject({
      plan: Plan.ULTRA,
      manualPlan: Plan.ULTRA,
      detectedPlan: Plan.UNSPECIFIED,
    });
    expect(proxyCapacityGroups(manual.accounts)[0]?.windows[0]).toMatchObject({ total: 10, remaining: 5 });
    expect((await gw.api.listProxies({})).proxies[0]?.accounts?.accounts[0]?.manualPlan).toBe(Plan.ULTRA);

    // Token refresh can change the email and runtime index; the auth file's ID remains stable.
    email = "renamed-and-long-account@example.test";
    index = "refreshed-index";
    detected = "pro";
    const refreshed = await fresh();
    expect(refreshed.accounts[0]).toMatchObject({
      planKey: account.planKey,
      plan: Plan.ULTRA,
      detectedPlan: Plan.PRO,
      manualPlan: Plan.ULTRA,
    });
    expect(proxyCapacityGroups(refreshed.accounts)[0]?.windows[0]?.total).toBe(10);

    const team = await gw.api.setProxyAccountPlan({ ...request, plan: Plan.TEAM });
    expect(proxyCapacityGroups(team.accounts)[0]?.windows[0]).toMatchObject({ total: 5, remaining: 2.5 });

    const other = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("other-plans@example.test", "Other")),
    );

    const foreign = create(ui.SetProxyAccountPlanRequestSchema, request);
    expect(await gw.runtime.runPromise(InstanceStore.use((s) => s.listProxies(other)))).toEqual([]);
    expect(
      await gw.runtime.runPromise(InstanceStore.use((s) => s.proxyManagement(other, proxyId)).pipe(Effect.flip)),
    ).toMatchObject({ message: "proxy not found" });
    expect(
      await gw.runtime.runPromise(InstanceStore.use((s) => s.setProxyAccountPlan(other, foreign)).pipe(Effect.flip)),
    ).toMatchObject({ message: "proxy not found" });
    await expect(gw.api.setProxyAccountPlan({ ...request, plan: Plan.PRO_500 })).rejects.toThrow();
    await expect(gw.api.setProxyAccountPlan({ ...request, accountKey: "missing" })).rejects.toThrow();

    const automatic = await gw.api.setProxyAccountPlan({ ...request, plan: Plan.UNSPECIFIED });
    expect(automatic.accounts[0]).toMatchObject({ plan: Plan.PRO, detectedPlan: Plan.PRO });
    expect(automatic.accounts[0]?.manualPlan).toBeUndefined();
    expect(proxyCapacityGroups(automatic.accounts)[0]?.windows[0]?.total).toBe(1);
    await gw.api.setProxyAccountPlan(request);
    present = false;
    expect((await fresh()).accounts).toEqual([]);
    await expect(gw.api.setProxyAccountPlan(request)).rejects.toThrow();
  });
});
