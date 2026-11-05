import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, ProviderProfileKind } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { applyWorkerConfig } from "@canopy/worker/config";
import { configComputer, editInstance, instanceOf, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually } from "./support/gateway.ts";

const wait = async (predicate: () => Promise<boolean>) =>
  expect(await eventually(predicate, Boolean, 20_000)).toBe(true);

describe.skipIf(!dockerAvailable)("linked provider reports come from the worker's home", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;

  beforeAll(async () => {
    a = await configComputer("MacBook");
    b = await configComputer("Mac Studio");
    await pairConfig(a, b);
    await editInstance(a, Provider.CLAUDE, "native", {
      label: "Proxy",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:18317",
      apiKey: "fixture-proxy-key",
    });
    await wait(async () => (await instanceOf(b, Provider.CLAUDE, "native"))?.label === "Proxy");
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled([a?.close(), b?.close()]);
  }, 30_000);

  async function report(computer: ConfigComputer, version: string) {
    await wait(
      async () =>
        computer.gateway.worker.configs
          .at(-1)
          ?.profiles.some((p) => p.providers.includes(Provider.CLAUDE) && p.kind === ProviderProfileKind.CLIPROXYAPI) ??
        false,
    );
    const config = computer.gateway.worker.configs.at(-1)!;

    const applied = applyWorkerConfig(config, {
      which: (command) => `/fixture/${command}`,
      version: () => version,
      realDirectory: (path) => path,
    });

    computer.gateway.worker.link.send({ case: "configApplied", value: applied.report });
    await wait(async () => (await instanceOf(computer, Provider.CLAUDE, "native"))?.workers[0]?.version === version);
  }

  test("both overviews preserve auth, version, connection and check time for the remote proxy", async () => {
    await report(a, "2.1.318");
    await report(b, "2.1.319");

    for (const [viewer, home] of [
      [a, b],
      [b, a],
    ]) {
      const local = (await instanceOf(home!, Provider.CLAUDE, "native"))!.workers[0]!;

      const remote = (await viewer!.gateway.api.getOverview({})).workers
        .find((w) => w.id === qualifyId(home!.gateway.workerId, home!.node))
        ?.providerInstances.find((i) => i.harness === Provider.CLAUDE && i.id === "native");

      expect(remote?.status).toEqual({ ...local, workerId: qualifyId(home!.gateway.workerId, home!.node) });
      expect(remote?.status).toMatchObject({
        reported: true,
        available: true,
        authenticated: true,
        auth: "endpoint key",
        kind: ProviderProfileKind.CLIPROXYAPI,
        synced: true,
      });
      expect(remote?.status?.checkedAt).toBeDefined();
    }
  }, 30_000);

  test("a home worker override is reported independently of the viewer's shared instance", async () => {
    const proxy = (
      await b.gateway.api.saveProxy({
        name: "Worker proxy",
        kind: "cliproxyapi",
        baseUrl: "http://127.0.0.1:18318",
        secret: "fixture-worker-key",
      })
    ).proxy!;

    await b.gateway.api.setInstanceWorker({
      harness: Provider.CLAUDE,
      id: "native",
      workerId: b.gateway.workerId,
      overrides: { proxyId: proxy.id },
    });
    await wait(async () => (await a.gateway.api.listProxies({})).proxies.some((p) => p.id === proxy.id));
    await wait(
      async () =>
        b.gateway.worker.configs
          .at(-1)
          ?.profiles.some((p) => p.providers.includes(Provider.CLAUDE) && p.baseUrl === "http://127.0.0.1:18318") ??
        false,
    );
    await report(b, "2.1.320");

    const remote = (await a.gateway.api.getOverview({})).workers
      .find((w) => w.nodeId === b.node)
      ?.providerInstances.find((i) => i.harness === Provider.CLAUDE && i.id === "native")?.status;

    expect(remote?.overrides?.proxyId).toBe(proxy.id);
    expect(remote?.version).toBe("2.1.320");
    expect(remote?.auth).toBe("endpoint key");
    expect(remote?.kind).toBe(ProviderProfileKind.CLIPROXYAPI);
    expect((await instanceOf(a, Provider.CLAUDE, "native"))?.workers[0]?.overrides?.proxyId).toBe("");
  }, 30_000);
});
