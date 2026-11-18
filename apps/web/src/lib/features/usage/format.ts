export type UsageView = "cost" | "tokens";

export interface UsageAmounts {
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
  reasoning: bigint;
  cost: number;
  estimatedCost: number;
  effectiveCost: number;
  estimatedCostReports: bigint;
  effectiveReportedCostReports: bigint;
  effectiveEstimatedCostReports: bigint;
  unknownEffectiveCostReports: bigint;
  reports: bigint;
  costReports: bigint;
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
}

const numbers = new Intl.NumberFormat(undefined);
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 });

export const count = (value: bigint) => numbers.format(value);
export const shortCount = (value: bigint) => compact.format(value);
export const totalTokens = (amounts: UsageAmounts) => amounts.input + amounts.output;

export const reportedCost = (amounts: UsageAmounts) =>
  amounts.costReports > 0n || amounts.cost > 0 ? dollars.format(amounts.cost) : "Unknown";

export const estimatedCost = (amounts: UsageAmounts) =>
  amounts.estimatedCostReports > 0n || amounts.estimatedCost > 0 ? dollars.format(amounts.estimatedCost) : "Unknown";

export const effectiveCostReports = (amounts: UsageAmounts) =>
  amounts.effectiveReportedCostReports + amounts.effectiveEstimatedCostReports;

export const hasEffectiveCost = (amounts: UsageAmounts) => effectiveCostReports(amounts) > 0n;

export const effectiveCost = (amounts: UsageAmounts) =>
  hasEffectiveCost(amounts) ? dollars.format(amounts.effectiveCost) : "Unknown";

export function costSource(amounts: UsageAmounts): string {
  if (!hasEffectiveCost(amounts)) return "Unknown cost";

  const source =
    amounts.effectiveEstimatedCostReports === 0n
      ? "Reported"
      : amounts.effectiveReportedCostReports === 0n
        ? "API equivalent"
        : "Reported + API equivalent";

  return amounts.unknownEffectiveCostReports > 0n ? `${source} · partial` : source;
}

export const metricValue = (amounts: UsageAmounts, view: UsageView) =>
  view === "cost" ? effectiveCost(amounts) : count(totalTokens(amounts));

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
