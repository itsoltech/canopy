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

export const count = (value: bigint) => numbers.format(value);
export const shortCount = (value: bigint) => compact.format(value);
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
