import { Provider, ui, type ProviderUsageWindow } from "@canopy/contracts";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { proxyAccountMark } from "./proxy-accounts.ts";
import { usageTone, type UsageGlance } from "./sidebar-usage.ts";

const Plan = ui.ProxyAccountPlan;

/**
 * Reviewed 2026-11-14. Units are relative to Claude Pro / Codex Plus, per window.
 * https://support.claude.com/en/articles/11049741-what-is-the-max-plan
 * https://support.claude.com/en/articles/17728952-what-is-the-ultra-plan
 * Max is 5x per five hours and week. Ultra (formerly Max 20x) is 10x weekly;
 * verified Ultra has no five-hour cap. Never invent a missing window.
 * https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers
 * https://learn.chatgpt.com/docs/pricing
 * Current Pro 100/200/500 allowances changed; no current numerical ratio is
 * published on these pages. Generic Pro also cannot identify a price tier.
 * https://x.ai/pricing and https://docs.x.ai/x-subscription/usage-limits
 * Grok consumer Plus/Premium/Super/Ultra pools are 1/4/15/50x weekly, but API
 * usage is billed separately. These ratios do not describe proxy API limits.
 * All unverified provider/plan/window combinations use 1x and remain flagged.
 */
const weights = new Map<string, number>([
  [`CLAUDE:${Plan.PRO}:five_hour`, 1],
  [`CLAUDE:${Plan.PRO}:seven_day`, 1],
  [`CLAUDE:${Plan.MAX}:five_hour`, 5],
  [`CLAUDE:${Plan.MAX}:seven_day`, 5],
  [`CLAUDE:${Plan.MAX_5X}:five_hour`, 5],
  [`CLAUDE:${Plan.MAX_5X}:seven_day`, 5],
  [`CLAUDE:${Plan.MAX_20X}:seven_day`, 10],
  [`CLAUDE:${Plan.ULTRA}:seven_day`, 10],
  [`CODEX:${Plan.PLUS}:five_hour`, 1],
  [`CODEX:${Plan.PLUS}:seven_day`, 1],
]);

export function proxyPlanWeight(account: ui.ProxyAccount, key = "seven_day") {
  const units = weights.get(`${proxyAccountMark(account.provider)}:${account.plan}:${key}`);

  return { units: units ?? 1, unknown: units === undefined };
}

export const supportedProxyAccounts = (accounts: readonly ui.ProxyAccount[]) =>
  accounts.filter((account) => proxyAccountMark(account.provider) !== undefined);

export const unsupportedProxyAccountText = (count: number) =>
  `${count} account${count === 1 ? "" : "s"} for an unsupported provider`;

export interface CapacityWindow {
  readonly key: string;
  readonly windowMinutes: number;
  readonly total: number;
  readonly remaining: number;
  readonly percentLeft: number;
  readonly reporting: number;
  readonly unknown: number;
  readonly resetsAt: ProviderUsageWindow["resetsAt"];
}

export interface ProxyCapacityGroup {
  readonly mark: "CLAUDE" | "CODEX" | "GROK";
  readonly name: string;
  readonly accounts: readonly ui.ProxyAccount[];
  readonly excluded: number;
  readonly windows: readonly CapacityWindow[];
}

const eligible = (account: ui.ProxyAccount) => account.status === "active" || account.status === "cooling_down";

const current = (window: ProviderUsageWindow, now: number) =>
  (!window.resetsAt || timestampDate(window.resetsAt).getTime() > now) &&
  (window.reached || (window.usedPercent !== undefined && Number.isFinite(window.usedPercent)));

/**
 * Missing/expired/percentage-free readings never enter a window's denominator.
 * Disabled, sign-in, error and unknown statuses are excluded. Cooling accounts
 * and accounts with any current reached window retain their units but have no
 * available capacity until a fresh reading says otherwise. No resets inferred.
 */
function capacityWindow(
  accounts: readonly ui.ProxyAccount[],
  sample: ProviderUsageWindow,
  now: number,
): CapacityWindow {
  let total = 0;
  let remaining = 0;
  let reporting = 0;
  let unknown = 0;
  let resetsAt: ProviderUsageWindow["resetsAt"];

  for (const account of accounts.filter(eligible)) {
    const window = account.windows.find(
      (w) => w.key === sample.key && w.windowMinutes === sample.windowMinutes && current(w, now),
    );

    if (!window) continue;
    const weight = proxyPlanWeight(account, window.key);

    const blocked =
      account.status === "cooling_down" ||
      account.windows.some((w) => current(w, now) && (w.reached || (w.usedPercent ?? 0) >= 100));

    total += weight.units;
    remaining += blocked ? 0 : weight.units * (1 - Math.max(0, Math.min(100, window.usedPercent ?? 100)) / 100);
    reporting++;

    if (weight.unknown) unknown++;

    if (window.resetsAt && (!resetsAt || timestampDate(window.resetsAt) < timestampDate(resetsAt)))
      resetsAt = window.resetsAt;
  }

  return {
    key: sample.key,
    windowMinutes: sample.windowMinutes,
    total,
    remaining,
    percentLeft: total ? (remaining / total) * 100 : 0,
    reporting,
    unknown,
    resetsAt,
  };
}

/** Pure projection of the existing cached observations; never triggers reads. */
export function proxyCapacityGroups(accounts: readonly ui.ProxyAccount[], now = Date.now()): ProxyCapacityGroup[] {
  const providers = [
    { mark: "CLAUDE", name: "Claude" },
    { mark: "CODEX", name: "Codex" },
    { mark: "GROK", name: "Grok" },
  ] as const;

  return providers.flatMap(({ mark, name }) => {
    const own = accounts.filter((account) => proxyAccountMark(account.provider) === mark);

    if (!own.length) return [];
    const samples = new Map<string, ProviderUsageWindow>();

    for (const account of own.filter(eligible)) {
      for (const window of account.windows.filter((w) => current(w, now)))
        samples.set(`${window.key}:${window.windowMinutes}`, window);
    }

    const windows = [...samples.values()]
      .flatMap((window) => {
        const capacity = capacityWindow(own, window, now);

        return capacity.total > 0 ? [capacity] : [];
      })
      .sort((a, b) => a.percentLeft - b.percentLeft || a.key.localeCompare(b.key));

    return [
      {
        mark,
        name,
        accounts: [...own].sort(
          (a, b) =>
            Math.max(0, ...b.windows.map((w) => w.usedPercent ?? 0)) -
              Math.max(0, ...a.windows.map((w) => w.usedPercent ?? 0)) || a.id.localeCompare(b.id),
        ),
        excluded: own.filter((account) => !eligible(account)).length,
        windows,
      },
    ];
  });
}

const providers = { CLAUDE: Provider.CLAUDE, CODEX: Provider.CODEX, GROK: Provider.GROK };

/** Combine proxy units across connections, then preserve the worst direct reading. */
export function proxyCapacityGlance(
  proxies: readonly ui.Proxy[],
  direct: readonly UsageGlance[],
  now = Date.now(),
): UsageGlance[] {
  const accounts = proxies.flatMap((proxy) =>
    proxy.kind === "cliproxyapi" && proxy.usedBy.length && proxy.accounts?.state === "ok"
      ? proxy.accounts.accounts
      : [],
  );

  const groups = proxyCapacityGroups(accounts, now);
  const result = new Map(direct.map((glance) => [glance.provider, glance]));

  for (const group of groups) {
    const worst = group.windows[0];

    if (!worst) continue;
    const provider = providers[group.mark];
    const previous = result.get(provider);
    const percent = 100 - worst.percentLeft;

    if (previous?.tone === "extra" || (previous?.percent ?? -1) > percent) continue;
    result.set(provider, {
      provider,
      name: group.name,
      percent,
      tone: usageTone(percent),
      label: `${group.name}: ${Math.round(worst.percentLeft)}% capacity left${worst.unknown ? ", unknown plan weights" : ""}`,
    });
  }

  return [...result.values()].sort((a, b) => a.provider - b.provider);
}
