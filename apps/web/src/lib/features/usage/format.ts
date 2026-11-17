export type UsageView = "cost" | "tokens";

export interface UsageAmounts {
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
  reasoning: bigint;
  cost: number;
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

export const metricValue = (amounts: UsageAmounts, view: UsageView) =>
  view === "cost" ? reportedCost(amounts) : count(totalTokens(amounts));

export const metricNumber = (amounts: UsageAmounts, view: UsageView) =>
  view === "cost" ? amounts.cost : Number(totalTokens(amounts));

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
