import { ui, type ProviderUsageWindow } from "@canopy/contracts";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { proxyAccountMark, proxyPlanName } from "./proxy-accounts.ts";

const Plan = ui.ProxyAccountPlan;

/**
 * Weekly (and five-hour) allowance relative to the provider's $20 plan, from the providers' own statements.
 * Reviewed 2026-11-15. Plans come only from provider identifiers; a proxy's own multiplier is never read.
 *
 * Claude, https://support.claude.com/en/articles/11049741-what-is-the-max-plan and
 * https://support.claude.com/en/articles/17728952-what-is-the-ultra-plan: Pro 1, Max 5x 5 per five hours and
 * week, Ultra (formerly Max 20x) 10 per week and no five-hour cap.
 * Team = Max 5x (5 per week and five hours): user-provided equivalence, 2026-11-15;
 * not independently confirmed by Anthropic.
 *
 * Codex, https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers and OpenAI's Codex limits
 * announcement of 2026-11-08: Plus 1, Pro 100 (`prolite`) 10, Pro 200 (`pro`) 20, Pro 500 (`promax`) 50 times
 * Plus per week. Pro plans have no five-hour limit, so no five-hour weight is invented for them.
 *
 * Grok consumer pools (https://x.ai/pricing) do not describe proxy API limits. Every other
 * provider/plan/window combination counts as 1 and stays flagged as unknown.
 */
const weights = new Map<string, number>([
  [`CLAUDE:${Plan.PRO}:five_hour`, 1],
  [`CLAUDE:${Plan.PRO}:seven_day`, 1],
  [`CLAUDE:${Plan.MAX}:five_hour`, 5],
  [`CLAUDE:${Plan.MAX}:seven_day`, 5],
  [`CLAUDE:${Plan.MAX_5X}:five_hour`, 5],
  [`CLAUDE:${Plan.MAX_5X}:seven_day`, 5],
  [`CLAUDE:${Plan.TEAM}:five_hour`, 5],
  [`CLAUDE:${Plan.TEAM}:seven_day`, 5],
  [`CLAUDE:${Plan.MAX_20X}:seven_day`, 10],
  [`CLAUDE:${Plan.ULTRA}:seven_day`, 10],
  [`CODEX:${Plan.PLUS}:five_hour`, 1],
  [`CODEX:${Plan.PLUS}:seven_day`, 1],
  [`CODEX:${Plan.PRO_100}:seven_day`, 10],
  [`CODEX:${Plan.PRO_200}:seven_day`, 20],
  [`CODEX:${Plan.PRO_500}:seven_day`, 50],
]);

export function proxyPlanWeight(account: ui.ProxyAccount, key = "seven_day") {
  const units = weights.get(`${proxyAccountMark(account.provider)}:${account.plan}:${key}`);

  return { units: units ?? 1, unknown: units === undefined };
}

export function proxyAutomaticPlanLabel(account: ui.ProxyAccount) {
  const weight = proxyPlanWeight({ ...account, plan: account.detectedPlan });
  const name = proxyPlanName(account.detectedPlan) ?? "Unknown plan";

  return `Automatic · ${name}${weight.unknown ? "" : ` · ×${weight.units}`}`;
}

/** Manual choices use the same confirmed weights as the capacity projection. Grok has no known weights. */
export function proxyPlanOptions(provider: string) {
  const mark = proxyAccountMark(provider);

  const choices = {
    CLAUDE: [
      [Plan.PRO, "Pro"],
      [Plan.MAX_5X, "Max 5x"],
      [Plan.TEAM, "Team"],
      [Plan.ULTRA, "Ultra"],
    ],
    CODEX: [
      [Plan.PLUS, "Plus"],
      [Plan.PRO_100, "Pro 100"],
      [Plan.PRO_200, "Pro 200"],
      [Plan.PRO_500, "Pro 500"],
    ],
    GROK: [],
  } satisfies Record<string, [ui.ProxyAccountPlan, string][]>;

  const plans = mark ? choices[mark] : [];

  return plans.map(([plan, name]) => ({ plan, label: `${name} · ×${weights.get(`${mark}:${plan}:seven_day`)}` }));
}

export const supportedProxyAccounts = (accounts: readonly ui.ProxyAccount[]) =>
  accounts.filter((account) => proxyAccountMark(account.provider) !== undefined);

export const unsupportedProxyAccountText = (count: number) =>
  `${count} account${count === 1 ? "" : "s"} for an unsupported provider`;

/** One account's share of a window: its plan units and what it has left. */
export interface CapacitySegment {
  readonly units: number;
  readonly percentLeft: number;
  /** The account itself, so its windows can be lined up across bars. */
  readonly account: ui.ProxyAccount;
}

export interface CapacityWindow {
  readonly key: string;
  readonly windowMinutes: number;
  readonly total: number;
  readonly remaining: number;
  readonly percentLeft: number;
  readonly reporting: number;
  readonly unknown: number;
  readonly resetsAt: ProviderUsageWindow["resetsAt"];
  /** The reporting accounts, in account order; their units add up to `total`. */
  readonly segments: readonly CapacitySegment[];
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

const periods = new Set([
  "five_hour",
  "one_day",
  "seven_day",
  "thirty_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
]);

const comparable = (window: ProviderUsageWindow) =>
  periods.has(window.key) || (window.key === "duration" && window.windowMinutes > 0);

// Standard keys already identify the duration, including cached reads from older gateways.
const windowIdentity = (window: ProviderUsageWindow) =>
  `${window.key}:${window.key === "duration" ? window.windowMinutes : 0}`;

const modelLimits = new Set(["seven_day_opus", "seven_day_sonnet"]);

/**
 * Missing/expired/percentage-free readings never enter a window's denominator.
 * Disabled, sign-in, error and unknown statuses are excluded. Cooling accounts
 * and accounts with a current reached general window retain their units but have
 * no available capacity until a fresh reading says otherwise. Model limits affect
 * only their own window. No resets inferred.
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
  const segments: CapacitySegment[] = [];

  for (const account of accounts.filter(eligible)) {
    const window = account.windows.find((w) => windowIdentity(w) === windowIdentity(sample) && current(w, now));

    if (!window) continue;
    const weight = proxyPlanWeight(account, window.key);

    const blocked =
      account.status === "cooling_down" ||
      account.windows.some(
        (w) =>
          (!modelLimits.has(w.key) || w.key === window.key) &&
          current(w, now) &&
          (w.reached || (w.usedPercent ?? 0) >= 100),
      );

    const left = blocked ? 0 : 100 - Math.max(0, Math.min(100, window.usedPercent ?? 100));

    total += weight.units;
    remaining += (weight.units * left) / 100;
    segments.push({ units: weight.units, percentLeft: left, account });
    reporting++;

    if (weight.unknown) unknown++;

    if (window.resetsAt && (!resetsAt || timestampDate(window.resetsAt) < timestampDate(resetsAt)))
      resetsAt = window.resetsAt;
  }

  return {
    key: sample.key,
    windowMinutes: sample.key === "duration" ? sample.windowMinutes : 0,
    total,
    remaining,
    percentLeft: total ? (remaining / total) * 100 : 0,
    reporting,
    unknown,
    resetsAt,
    segments,
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
      for (const window of account.windows.filter((w) => comparable(w) && current(w, now)))
        samples.set(windowIdentity(window), window);
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
