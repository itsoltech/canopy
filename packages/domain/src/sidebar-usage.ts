import { Provider, ProviderProfileKind, type ProviderUsageSnapshot, type ui } from "@canopy/contracts";
import { activeUsageWindows, usageBillingNotice } from "./provider-usage.ts";

export type UsageTone = "neutral" | "warning" | "danger" | "extra";

/** Extension point for upstream status; never infer proxy quotas from plan windows. */
export interface ProxyUsageSection {
  readonly proxyId: string;
  readonly label: string;
  readonly accountCount: number;
  readonly coolingDownCount: number;
}

export interface SidebarUsageAccount {
  readonly key: string;
  readonly provider: Provider;
  readonly label: string;
  readonly computer: string;
  readonly usage: ProviderUsageSnapshot;
}

export interface UsageGlance {
  readonly provider: Provider;
  readonly name: string;
  readonly percent: number | undefined;
  readonly tone: UsageTone;
  readonly label: string;
}

export function usageTone(percent: number, extra = false): UsageTone {
  return extra ? "extra" : percent >= 90 ? "danger" : percent >= 70 ? "warning" : "neutral";
}

/** Worker overview is the only source; disabled and proxy instances do not contribute. */
export function sidebarUsageAccounts(workers: readonly ui.Worker[], now = Date.now()): SidebarUsageAccount[] {
  return workers.flatMap((worker) =>
    worker.providerInstances.flatMap((instance) => {
      const usage = instance.usage;

      if (
        !instance.enabled ||
        instance.kind === ProviderProfileKind.CLIPROXYAPI ||
        !usage ||
        (!activeUsageWindows(usage, now).length && !usageBillingNotice(usage, now))
      )
        return [];

      return [
        {
          key: `${worker.id}:${instance.harness}:${instance.id}`,
          provider: instance.harness,
          label: instance.label || (instance.id === "native" ? "Device login" : instance.id),
          computer: worker.name || worker.hostname,
          usage,
        },
      ];
    }),
  );
}

/** One worst-window bar per provider; paid activity outranks a plan percentage. */
export function sidebarUsageGlance(accounts: readonly SidebarUsageAccount[], now = Date.now()): UsageGlance[] {
  const providers = [
    { provider: Provider.CLAUDE, name: "Claude" },
    { provider: Provider.CODEX, name: "Codex" },
    { provider: Provider.GROK, name: "Grok" },
  ];

  return providers.flatMap(({ provider, name }) => {
    const rows = accounts.filter((account) => account.provider === provider);

    if (!rows.length) return [];
    const windows = rows.flatMap((account) => activeUsageWindows(account.usage, now));

    const percentages = windows.flatMap((window) =>
      window.reached ? [100] : window.usedPercent === undefined ? [] : [window.usedPercent],
    );

    const percent = percentages.length ? Math.max(...percentages) : undefined;
    const extra = rows.some((account) => account.usage.usingExtraUsage === true);

    const formatted =
      percent === undefined
        ? undefined
        : new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(percent);

    const tone = usageTone(percent ?? 0, extra);

    return [
      {
        provider,
        name,
        percent,
        tone,
        label: extra
          ? `${name}: extra usage active`
          : formatted === undefined
            ? `${name}: usage reported`
            : `${name}: ${formatted}% used`,
      },
    ];
  });
}
