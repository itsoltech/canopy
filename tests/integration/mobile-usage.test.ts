import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { CommandResultSchema, Provider, UsageScope, ui } from "@canopy/contracts";
import { dockerAvailable, startPostgres } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { hasEffectiveCost, usageReport } from "@canopy/domain/usage-report";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { Layer, ManagedRuntime } from "effect";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { openListener } from "../../apps/gateway/src/network/listener.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { gatewayServices } from "../../apps/gateway/src/runtime.ts";
import { accountGeneration } from "../../apps/gateway/src/usage/generation.ts";
import { routedMobileClient, type PinnedTransport } from "../../apps/mobile/src/api/routes.ts";
import { requestUsageReport } from "../../apps/mobile/src/features/usage/request.ts";
import { nodePinnedTransport } from "./support/phone.ts";

const usageMethods = ["GetUsageStats"];

async function usageGateway(
  handlers: Partial<ServiceImpl<typeof ui.GatewayService>>,
  transport = nodePinnedTransport(),
) {
  const identity = await generateIdentity();
  const host = "127.0.0.1";
  const adapter = connectNodeAdapter({ routes: (router) => router.service(ui.GatewayService, handlers) });
  const server = await openListener({ host, port: 0, identity, route: () => adapter });

  const { api } = routedMobileClient({
    connection: { addresses: [`https://${host}:${server.port}`], fingerprint: identity.fingerprint },
    transport,
  });

  return { api, close: () => server.close() };
}

describe("native Usage report over pinned Connect", () => {
  test.each([
    { label: "old gateway without capability discovery", methods: undefined, reportCalls: 0 },
    { label: "gateway without the report capability", methods: ["GetOverview"], reportCalls: 0 },
    { label: "gateway that advertises an unimplemented report", methods: usageMethods, reportCalls: 1 },
  ])("$label returns unavailable", async ({ methods, reportCalls }) => {
    let calls = 0;

    const gateway = await usageGateway({
      ...(methods && { getClientCapabilities: () => ({ methods: [...methods] }) }),
      getUsageStats: () => {
        calls++;
        throw new ConnectError("Report is unavailable on this build", Code.Unimplemented);
      },
    });

    try {
      const result = await requestUsageReport(gateway.api, { days: 7 }, new AbortController().signal);
      expect(result).toEqual({ status: "unavailable" });
      expect(calls).toBe(reportCalls);
    } finally {
      await gateway.close();
    }
  });

  test("a transient capability error can be retried", async () => {
    let calls = 0;

    const gateway = await usageGateway({
      getClientCapabilities: () => {
        if (++calls === 1) throw new ConnectError("Connection interrupted", Code.Unavailable);

        return { methods: usageMethods };
      },
      getUsageStats: () => ({ totals: { inputTokens: 27n } }),
    });

    try {
      const signal = new AbortController().signal;
      await expect(requestUsageReport(gateway.api, { days: 7 }, signal)).rejects.toMatchObject({
        code: Code.Unavailable,
      });
      expect(await requestUsageReport(gateway.api, { days: 7 }, signal)).toMatchObject({
        status: "ready",
        data: { totals: { inputTokens: 27n } },
      });
    } finally {
      await gateway.close();
    }
  });

  test("legacy cost fields distinguish a known zero from missing cost", async () => {
    const gateway = await usageGateway({
      getClientCapabilities: () => ({ methods: usageMethods }),
      getUsageStats: () => ({
        totals: { reports: 3n, reportedCostUsd: 1.25, unknownCostReports: 1n },
        providers: [
          { key: "claude", totals: { reports: 1n, reportedCostUsd: 0 } },
          { key: "codex", totals: { reports: 1n, reportedCostUsd: 1.25 } },
          { key: "grok", totals: { reports: 1n, unknownCostReports: 1n } },
        ],
      }),
    });

    try {
      const result = await requestUsageReport(gateway.api, { days: 30 }, new AbortController().signal);

      if (result.status !== "ready") throw new Error("Expected a legacy Usage report");
      const { totals, providers } = usageReport(result.data, { legacyReportedCost: true });
      expect(hasEffectiveCost(totals)).toBe(false);
      expect(totals.unknownEffectiveCostReports).toBe(1n);
      expect(providers.map(({ key, amounts }) => [key, hasEffectiveCost(amounts), amounts.effectiveCost])).toEqual([
        ["claude", true, 0],
        ["codex", true, 1.25],
        ["grok", false, 0],
      ]);
    } finally {
      await gateway.close();
    }
  });

  test("cancelling an in-flight report allows a new filtered request", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const pinned = nodePinnedTransport();
    let reportSignal: AbortSignal | null | undefined;

    const transport: PinnedTransport = {
      ...pinned,
      fetch: (url, init, pin) => {
        if (url.endsWith("/GetUsageStats")) reportSignal = init?.signal;

        return pinned.fetch(url, init, pin);
      },
    };

    const gateway = await usageGateway(
      {
        getClientCapabilities: () => ({ methods: usageMethods }),
        getUsageStats: async (request) => {
          if (request.days === 7) {
            started.resolve();
            await release.promise;
          }

          return { totals: { inputTokens: BigInt(request.days) } };
        },
      },
      transport,
    );

    try {
      const cancelled = requestUsageReport(gateway.api, { days: 7 }, controller.signal).catch(
        (cause: unknown) => ConnectError.from(cause).code,
      );

      await started.promise;
      controller.abort();
      expect(reportSignal?.aborted).toBe(true);
      expect(await requestUsageReport(gateway.api, { days: 30 }, new AbortController().signal)).toMatchObject({
        status: "ready",
        data: { totals: { inputTokens: 30n } },
      });
      release.resolve();
      expect(await cancelled).toBe(Code.Canceled);
    } finally {
      controller.abort();
      release.resolve();
      await gateway.close();
    }
  });
});

test.skipIf(!dockerAvailable)(
  "a paired mobile device reads filtered Usage and loses access after revocation",
  async () => {
    const pg = await startPostgres({ migrated: true });
    const key = randomBytes(32);
    const runtime = ManagedRuntime.make(gatewayServices(key).pipe(Layer.provideMerge(pg.layer)));
    let core: GatewayCore | undefined;
    let unmount: (() => void) | undefined;

    try {
      const userId = await runtime.runPromise(
        GatewayStore.use((store) => store.ensureUser("usage@example.test", "Usage")),
      );

      core = new GatewayCore({ runtime, userId, instanceId: "mobile-usage" });
      const network = new NetworkAccess({ store: new ComputerStore(runtime, userId, key), host: "127.0.0.1", port: 0 });
      core.network = network;
      unmount = mountMobileNetwork(core, network, randomBytes(32).toString("hex"));
      await network.start();
      await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
      const transport = nodePinnedTransport();
      const connection = core.mobile.networkRoutes();
      const invitation = await core.mobile.create();

      const paired = await routedMobileClient({ connection, transport }).pairing.exchangeMobilePairing({
        code: invitation.code,
        name: "Fixture phone",
        platform: "ios",
      });

      const { api } = routedMobileClient({ connection, token: paired.deviceToken, transport });

      for (const [provider, requestedServiceTier, inputTokens] of [
        [Provider.CODEX, "", 17n],
        [Provider.CODEX, "fast", 29n],
        [Provider.CLAUDE, "", 41n],
      ] as const) {
        await accountGeneration(
          runtime,
          userId,
          provider,
          "fixture-model",
          create(CommandResultSchema, {
            commandId: Bun.randomUUIDv7(),
            ok: true,
            consumedUsage: { scope: UsageScope.TURN, requestedServiceTier, inputTokens, estimatedCostUsd: 0.25 },
          }),
        );
      }

      const request = { days: 7, provider: "codex", requestedServiceTier: "", activityKind: "generation" };
      const signal = new AbortController().signal;
      const report = await requestUsageReport(api, request, signal);

      expect(report.status).toBe("ready");

      if (report.status !== "ready") throw new Error("Expected a Usage report from the paired gateway");
      expect(report.data.days).toHaveLength(7);
      expect(report.data.totals).toMatchObject({ inputTokens: 17n, reports: 1n, effectiveCostUsd: 0.25 });
      expect(report.data.providers).toMatchObject([{ key: "codex", totals: { inputTokens: 17n } }]);
      expect(report.data.speeds).toMatchObject([{ key: "", totals: { inputTokens: 17n } }]);
      expect(report.data.activities).toMatchObject([{ key: "generation", totals: { inputTokens: 17n } }]);

      await core.mobile.revoke(paired.device!.id, "device");
      await expect(requestUsageReport(api, request, signal)).rejects.toMatchObject({ code: Code.Unauthenticated });
    } finally {
      unmount?.();
      await core?.network?.close();
      await core?.stopSweep();
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
