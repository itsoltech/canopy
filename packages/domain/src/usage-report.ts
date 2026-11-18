import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";

export type UsageView = "cost" | "tokens";

export interface UsageAmounts {
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
  reasoning: bigint;
  effectiveCost: number;
  effectiveCostReports: bigint;
  unknownEffectiveCostReports: bigint;
  reports: bigint;
}

export interface UsageRow {
  key: string;
  label: string;
  detail?: string;
  amounts: UsageAmounts;
}

export interface UsageDay extends UsageRow {
  providers: UsageRow[];
}

export interface UsageData {
  totals: UsageAmounts;
  providers: UsageRow[];
  models: UsageRow[];
  speeds: UsageRow[];
  activities: UsageRow[];
  bots: UsageRow[];
  days: UsageDay[];
  computers: {
    id: string;
    name: string;
    available: boolean;
    status: string;
    trackingSince: string;
    updatedAt: string;
  }[];
  partial: boolean;
  supportsActivityBreakdown: boolean;
  hasUnattributedUsage: boolean;
}

export const usageActivities = [
  { value: "thread", label: "Threads" },
  { value: "bot", label: "Bots" },
  {
    value: "generation",
    label: "Other generation",
    description: "Text Canopy generates for features such as thread titles.",
  },
  { value: "unattributed", label: "Unattributed" },
];

const numbers = new Intl.NumberFormat(undefined);
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

const supportsBigInt = (() => {
  try {
    // Some Intl implementations throw or round BigInts to doubles.
    return numbers.format(9_007_199_254_740_993n) !== numbers.format(9_007_199_254_740_992n);
  } catch {
    return false;
  }
})();

const supportsCompact = compact.resolvedOptions().notation === "compact";
const maxSafeCount = BigInt(Number.MAX_SAFE_INTEGER);

export function count(value: bigint): string {
  if (supportsBigInt) return numbers.format(value);

  // Hermes can format safe integers through Intl. Larger counts keep every digit.
  return value >= -maxSafeCount && value <= maxSafeCount ? numbers.format(Number(value)) : value.toString();
}

const compactUnits = [
  { size: 1_000_000_000_000n, suffix: "T" },
  { size: 1_000_000_000n, suffix: "B" },
  { size: 1_000_000n, suffix: "M" },
  { size: 1_000n, suffix: "K" },
];

export function shortCount(value: bigint): string {
  if (supportsBigInt && supportsCompact) return compact.format(value);

  const magnitude = value < 0n ? -value : value;
  const index = compactUnits.findIndex(({ size }) => magnitude >= size);
  const unit = compactUnits[index];

  if (!unit) return count(value);
  const sign = value < 0n ? "-" : "";
  const tenths = (magnitude * 10n + unit.size / 2n) / unit.size;
  const next = compactUnits[index - 1];

  if (next && tenths === 10_000n) return `${sign}1${next.suffix}`;
  const fraction = tenths % 10n;

  return `${sign}${tenths / 10n}${fraction ? `.${fraction}` : ""}${unit.suffix}`;
}

export const totalTokens = (amounts: UsageAmounts) => amounts.input + amounts.output;

export const hasEffectiveCost = (amounts: UsageAmounts) => amounts.effectiveCostReports > 0n;

export const hasPartialCost = (amounts: UsageAmounts) =>
  hasEffectiveCost(amounts) && amounts.unknownEffectiveCostReports > 0n;

export const effectiveCost = (amounts: UsageAmounts) =>
  hasEffectiveCost(amounts) ? dollars.format(amounts.effectiveCost) : "Unknown";

export function metricValue(amounts: UsageAmounts, view: UsageView): string {
  if (view === "tokens") return count(totalTokens(amounts));

  const cost = effectiveCost(amounts);

  return hasPartialCost(amounts) ? `${cost} (partial)` : cost;
}

export const metricNumber = (amounts: UsageAmounts, view: UsageView) =>
  view === "cost" ? amounts.effectiveCost : Number(totalTokens(amounts));

const providerNames = new Map([
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["grok", "Grok"],
]);

export const providerName = (value: string) => providerNames.get(value) ?? value;

const speedNames = new Map([
  ["", "Unknown"],
  ["default", "Standard"],
  ["fast", "Fast"],
  ["ultrafast", "Ultrafast"],
]);

export const speedName = (value: string) => speedNames.get(value) ?? value;

export const dayLabel = (value: string, full = false) =>
  new Intl.DateTimeFormat(undefined, {
    month: full ? "long" : "short",
    day: "numeric",
    ...(full && { year: "numeric" }),
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));

function usageAmounts(totals: ui.UsageTotals | undefined, legacyReportedCost: boolean): UsageAmounts {
  let effectiveCostReports =
    (totals?.effectiveReportedCostReports ?? 0n) + (totals?.effectiveEstimatedCostReports ?? 0n);

  const reports = totals?.reports ?? 0n;
  let effectiveCost = totals?.effectiveCostUsd ?? 0;
  let unknownEffectiveCostReports = totals?.unknownEffectiveCostReports ?? 0n;

  if (
    legacyReportedCost &&
    totals &&
    reports > 0n &&
    effectiveCostReports === 0n &&
    unknownEffectiveCostReports === 0n
  ) {
    // Legacy aggregates may include partial provider costs without a per-report breakdown.
    if (totals.unknownCostReports === 0n && Number.isFinite(totals.reportedCostUsd) && totals.reportedCostUsd >= 0) {
      effectiveCost = totals.reportedCostUsd;
      effectiveCostReports = reports;
    } else {
      effectiveCost = 0;
      unknownEffectiveCostReports = reports;
    }
  }

  return {
    input: totals?.inputTokens ?? 0n,
    output: totals?.outputTokens ?? 0n,
    cacheRead: totals?.cachedInputTokens ?? 0n,
    cacheWrite: totals?.cacheWriteInputTokens ?? 0n,
    reasoning: totals?.reasoningOutputTokens ?? 0n,
    effectiveCost,
    effectiveCostReports,
    unknownEffectiveCostReports,
    reports,
  };
}

const iso = (timestamp: Timestamp | undefined) => (timestamp ? timestampDate(timestamp).toISOString() : "");

function botRows(bots: ui.UsageBotBreakdown[], legacyReportedCost: boolean): UsageRow[] {
  const unnamed = "Unnamed bot";
  const names = new Map<string, number>();

  for (const bot of bots) {
    const label = bot.name || unnamed;
    names.set(label, (names.get(label) ?? 0) + 1);
  }

  return bots.map(({ botId, name, totals }) => ({
    key: botId,
    label: name || unnamed,
    ...((!name || (names.get(name) ?? 0) > 1) && { detail: botId }),
    amounts: usageAmounts(totals, legacyReportedCost),
  }));
}

export function usageReport(
  response: ui.GetUsageStatsResponse,
  { legacyReportedCost = false }: { legacyReportedCost?: boolean } = {},
): UsageData {
  const amounts = (totals: ui.UsageTotals | undefined) => usageAmounts(totals, legacyReportedCost);

  return {
    totals: amounts(response.totals),
    providers: response.providers.map((row) => ({
      key: row.key,
      label: providerName(row.key),
      amounts: amounts(row.totals),
    })),
    models: response.models.map((row) => ({
      key: row.key,
      label: row.key || "Unspecified model",
      amounts: amounts(row.totals),
    })),
    speeds: response.speeds.map((row) => ({
      key: row.key,
      label: speedName(row.key),
      amounts: amounts(row.totals),
    })),
    activities: response.activities.map((row) => ({
      key: row.key,
      label: usageActivities.find((activity) => activity.value === row.key)?.label ?? row.key,
      amounts: amounts(row.totals),
    })),
    bots: botRows(response.bots, legacyReportedCost),
    days: response.days
      .flatMap((row) => {
        if (!row.day) return [];
        const key = iso(row.day).slice(0, 10);

        return [
          {
            key,
            label: dayLabel(key, true),
            amounts: amounts(row.totals),
            providers: row.providers.map((provider) => ({
              key: provider.key,
              label: providerName(provider.key),
              amounts: amounts(provider.totals),
            })),
          },
        ];
      })
      .sort((a, b) => a.key.localeCompare(b.key)),
    computers: response.sources.map((source) => ({
      id: source.computerId,
      name: source.name || (source.local ? "This computer" : "Unnamed computer"),
      available: source.online,
      status: source.status || (source.online ? "ready" : "offline"),
      trackingSince: iso(source.trackingSince),
      updatedAt: iso(source.updatedAt),
    })),
    partial: response.partial,
    supportsActivityBreakdown: response.supportsActivityBreakdown,
    hasUnattributedUsage: response.hasUnattributedUsage,
  };
}
