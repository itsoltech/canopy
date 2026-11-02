/**
 * Live tests (OA_LIVE=1): a real worker behind the CLIProxyAPI, set up the way the product does it
 * (docs/worker-config.md, section 9): the worker's own part of the configuration (allowed roots, the harnesses,
 * no device login) and the proxy as the global "cliproxyapi" provider instance of each harness, enabled on that
 * worker through the UI API (key stored as a gateway secret, synced to the worker as its effective configuration).
 */
import { DeviceLogin, Provider, ProviderProfileKind, type ui } from "@open-agents/contracts";
import { GatewayStore } from "@open-agents/gateway/store";
import { eventually, type TestGateway } from "./gateway.ts";

/** The instance id live threads use (`providerProfileId`). */
const LIVE_PROFILE = "cliproxyapi";

export interface LiveProxyOptions {
  readonly url: string;
  readonly key: string;
  /** Directories the worker may open. */
  readonly allowedRoots: readonly string[];
  /** Harnesses enabled on the worker, each with the proxy instance (default: Codex and Claude). */
  readonly harnesses?: readonly Provider[];
}

/**
 * Configures a registered worker for live turns through the proxy. Call before the worker connects (it gets the
 * configuration in its handshake); a second worker of the same gateway gets the existing instances enabled.
 */
export async function useLiveProxy(gw: TestGateway, workerId: string, options: LiveProxyOptions): Promise<void> {
  const harnesses = options.harnesses ?? [Provider.CODEX, Provider.CLAUDE];
  const harness = (provider: Provider) =>
    harnesses.includes(provider) ? { enabled: true, deviceLogin: DeviceLogin.NONE } : { enabled: false };
  await gw.runtime.runPromise(
    GatewayStore.use((s) =>
      s.setWorkerConfig(workerId, { allowedRoots: [...options.allowedRoots], codex: harness(Provider.CODEX), claude: harness(Provider.CLAUDE) }, gw.userId),
    ),
  );
  const existing = (await gw.api.listProviderInstances({})).instances;
  for (const provider of harnesses) {
    if (existing.some((i) => i.harness === provider && i.id === LIVE_PROFILE)) {
      await gw.api.setInstanceWorker({ harness: provider, id: LIVE_PROFILE, workerId, enabled: true });
      continue;
    }
    await gw.api.saveProviderInstance({
      harness: provider,
      id: LIVE_PROFILE,
      create: true,
      label: "CLIProxyAPI",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: options.url,
      apiKey: options.key,
      workerIds: [workerId],
    });
  }
}

/** Waits until the connected worker applied its configuration and reports the proxy instances available (pickable). */
export async function liveProxyReady(gw: TestGateway, workerId: string, harnesses: readonly Provider[] = [Provider.CODEX, Provider.CLAUDE], timeoutMs = 60_000): Promise<void> {
  const ready = (worker: ui.Worker | undefined) =>
    !!worker &&
    worker.appliedVersion > 0n &&
    worker.appliedVersion === worker.configVersion &&
    harnesses.every((h) => worker.providerInstances.some((i) => i.harness === h && i.id === LIVE_PROFILE && i.enabled && i.available));
  const worker = await eventually(async () => (await gw.api.getOverview({})).workers.find((w) => w.id === workerId), ready, timeoutMs);
  if (!ready(worker)) throw new Error(`the worker did not report the ${LIVE_PROFILE} instances available: ${JSON.stringify(worker?.providerInstances.map((i) => [Provider[i.harness], i.id, i.enabled, i.available, i.detail]))}`);
}
