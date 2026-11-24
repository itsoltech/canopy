import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Provider, ProviderProfileKind, type ProviderUsageWindow, type ui } from "@canopy/contracts";
import { isUsageResetPlausible, usageWindowName } from "@canopy/domain/provider-usage";

const planWindows = new Set([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
]);

const historyMs = 10 * 60_000;

interface Reading {
  readonly source: string;
  readonly window: ProviderUsageWindow;
  readonly observedAt: number;
}

interface ReachedWindow {
  readonly resetAt: number;
  readonly observedAt: number;
}

interface ResetNotice {
  readonly key: string;
  readonly label: string;
}

function* directReadings(workers: readonly ui.Worker[]): Generator<Reading> {
  for (const worker of workers) {
    if (!worker.online || worker.appliedVersion !== worker.configVersion) continue;

    for (const instance of worker.providerInstances) {
      const { usage, account } = instance;

      if (
        !instance.enabled ||
        instance.harness !== Provider.CLAUDE ||
        instance.kind !== ProviderProfileKind.NATIVE ||
        !usage?.observedAt ||
        account?.state === "signed_out" ||
        account?.state === "expired"
      )
        continue;

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

function* proxyReadings(proxies: readonly ui.Proxy[]): Generator<Reading> {
  for (const proxy of proxies) {
    if (proxy.kind !== "cliproxyapi" || !proxy.usedBy.length || proxy.accounts?.state !== "ok") continue;

    for (const account of proxy.accounts.accounts) {
      if (
        account.provider !== "claude" ||
        !account.planKey ||
        (account.status !== "active" && account.status !== "cooling_down")
      )
        continue;
      const source = JSON.stringify([proxy.id, account.planKey, String(proxy.revision)]);

      for (const window of account.windows) {
        if (window.observedAt) yield { source, window, observedAt: timestampDate(window.observedAt).getTime() };
      }
    }
  }
}

/** Only a new reading for a previously exhausted window can confirm its renewal. */
export class ClaudeResets {
  #reached = new Map<string, ReachedWindow>();

  observe(workers: readonly ui.Worker[], proxies: readonly ui.Proxy[], now = Date.now()): ResetNotice[] {
    const reached = new Map<string, ReachedWindow>();
    const notices = new Map<string, ResetNotice>();

    for (const { source, window, observedAt } of [...directReadings(workers), ...proxyReadings(proxies)]) {
      if (!planWindows.has(window.key) || !Number.isFinite(observedAt)) continue;
      const identity = `${source}:${window.key}`;
      const before = this.#reached.get(identity);
      const resetAt = window.resetsAt && timestampDate(window.resetsAt).getTime();

      if (before && now - before.resetAt <= historyMs && observedAt <= before.observedAt) {
        reached.set(identity, before);
        continue;
      }

      if (window.reached || (window.usedPercent ?? 0) >= 100) {
        if (
          resetAt !== undefined &&
          isUsageResetPlausible(resetAt, now) &&
          (resetAt > Math.max(now, observedAt) || (resetAt === before?.resetAt && now - resetAt <= historyMs))
        )
          reached.set(identity, { resetAt, observedAt });
        continue;
      }

      if (!before || observedAt < before.resetAt || now < before.resetAt || now - before.resetAt > historyMs) continue;

      // An idle rolling window can report zero and no next deadline. An absent window never confirms a reset.
      if (
        resetAt === undefined
          ? window.usedPercent !== 0
          : resetAt <= Math.max(before.resetAt, observedAt) || !isUsageResetPlausible(resetAt, now)
      )
        continue;
      const key = `claude:${window.key.replaceAll("_", "-")}:${Math.floor(before.resetAt / 1000)}`;

      notices.set(key, { key, label: `${usageWindowName(window.key)} limit` });
    }

    this.#reached = reached;

    return [...notices.values()];
  }
}
