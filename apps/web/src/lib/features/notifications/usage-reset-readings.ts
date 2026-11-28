import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Provider, ProviderProfileKind, type ui } from "@canopy/contracts";
import type { ResetProvider, UsageResetReading } from "@canopy/domain/provider-usage-resets";

function* directReadings(workers: readonly ui.Worker[], provider: ResetProvider): Generator<UsageResetReading> {
  const harness = provider === "claude" ? Provider.CLAUDE : Provider.CODEX;

  for (const worker of workers) {
    if (!worker.online || worker.appliedVersion !== worker.configVersion) continue;

    for (const instance of worker.providerInstances) {
      const { usage, account } = instance;

      if (
        !instance.enabled ||
        instance.harness !== harness ||
        instance.kind !== ProviderProfileKind.NATIVE ||
        !usage?.observedAt ||
        account?.state === "signed_out" ||
        account?.state === "expired"
      )
        continue;

      if (provider === "codex") {
        const quota = usage.codexQuota;

        if (!quota?.observedAt || !quota.linkEpoch) continue;

        const source = JSON.stringify([
          worker.id,
          instance.id,
          String(worker.configVersion),
          String(quota.linkEpoch),
          quota.sessionKey,
          quota.accountKey,
        ]);

        for (const window of quota.windows)
          yield {
            source,
            window,
            observedAt: timestampDate(quota.observedAt).getTime(),
            accountKey: quota.accountKey,
            canConfirm: quota.ordinaryUsageAllowed,
          };

        continue;
      }

      const source = JSON.stringify([
        worker.id,
        instance.id,
        String(worker.configVersion),
        account?.email,
        account?.organization,
      ]);

      for (const window of usage.windows) {
        yield { source, window, observedAt: timestampDate(usage.observedAt).getTime() };
      }
    }
  }
}

function* proxyReadings(proxies: readonly ui.Proxy[], provider: ResetProvider): Generator<UsageResetReading> {
  for (const proxy of proxies) {
    if (proxy.kind !== "cliproxyapi" || !proxy.usedBy.length || proxy.accounts?.state !== "ok") continue;

    for (const account of proxy.accounts.accounts) {
      if (
        account.provider !== provider ||
        !account.planKey ||
        (account.status !== "active" && account.status !== "cooling_down")
      )
        continue;
      const codex = provider === "codex";
      const source = JSON.stringify([proxy.id, account.planKey, String(proxy.revision), account.codexQuotaAccountKey]);

      for (const window of account.windows) {
        if (window.observedAt)
          yield {
            source,
            window,
            observedAt: timestampDate(window.observedAt).getTime(),
            ...(codex && { accountKey: account.codexQuotaAccountKey, canConfirm: true, passive: true }),
          };
      }
    }
  }
}

export function* usageResetReadings(
  provider: ResetProvider,
  workers: readonly ui.Worker[],
  proxies: readonly ui.Proxy[],
) {
  yield* directReadings(workers, provider);
  yield* proxyReadings(proxies, provider);
}
