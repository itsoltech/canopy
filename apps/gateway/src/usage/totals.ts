import { clone, create } from "@bufbuild/protobuf";
import { ui, type Usage } from "@canopy/contracts";

export const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "reasoningOutputTokens",
] as const;

export const COUNT_FIELDS = [
  ...TOKEN_FIELDS,
  "reports",
  "unknownCostReports",
  "unknownEstimatedCostReports",
  "unknownEffectiveCostReports",
  "effectiveReportedCostReports",
  "effectiveEstimatedCostReports",
] as const;

export const COST_FIELDS = ["reportedCostUsd", "estimatedCostUsd", "effectiveCostUsd"] as const;

function validCost(cost: number | undefined): cost is number {
  return cost !== undefined && Number.isFinite(cost) && cost >= 0;
}

/** Older aggregate snapshots cannot separate complete reported amounts from partial ones. */
export function normalizeUsageTotals(totals: ui.UsageTotals): ui.UsageTotals {
  const next = clone(ui.UsageTotalsSchema, totals);

  if (
    next.reports > 0n &&
    next.estimatedCostUsd === 0 &&
    next.unknownEstimatedCostReports === 0n &&
    next.effectiveCostUsd === 0 &&
    next.unknownEffectiveCostReports === 0n &&
    next.effectiveReportedCostReports === 0n &&
    next.effectiveEstimatedCostReports === 0n
  ) {
    next.unknownEstimatedCostReports = next.reports;

    if (next.unknownCostReports === 0n) {
      next.effectiveCostUsd = next.reportedCostUsd;
      next.effectiveReportedCostReports = next.reports;
    } else next.unknownEffectiveCostReports = next.reports;
  }

  return next;
}

/** This operates on one counter, before aggregation can lose overlapping source coverage. */
function selectEffective(totals: ui.UsageTotals): void {
  const reported = totals.unknownCostReports === 0n;
  const estimated = !reported && totals.unknownEstimatedCostReports === 0n;
  totals.effectiveCostUsd = reported ? totals.reportedCostUsd : estimated ? totals.estimatedCostUsd : 0;
  totals.effectiveReportedCostReports = reported ? 1n : 0n;
  totals.effectiveEstimatedCostReports = estimated ? 1n : 0n;
  totals.unknownEffectiveCostReports = reported || estimated ? 0n : 1n;
}

export function usageTotals(usage: Usage): ui.UsageTotals {
  const totals = create(ui.UsageTotalsSchema, {
    inputTokens:
      usage.inputTokens > usage.cachedInputTokens + usage.cacheWriteInputTokens
        ? usage.inputTokens
        : usage.cachedInputTokens + usage.cacheWriteInputTokens,
    outputTokens: usage.outputTokens > usage.reasoningOutputTokens ? usage.outputTokens : usage.reasoningOutputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    reportedCostUsd: validCost(usage.reportedCostUsd) ? usage.reportedCostUsd : 0,
    estimatedCostUsd: validCost(usage.estimatedCostUsd) ? usage.estimatedCostUsd : 0,
    reports: 1n,
    unknownCostReports: validCost(usage.reportedCostUsd) ? 0n : 1n,
    unknownEstimatedCostReports: validCost(usage.estimatedCostUsd) ? 0n : 1n,
  });

  selectEffective(totals);

  return totals;
}

export function addTotals(target: ui.UsageTotals, added: ui.UsageTotals): void {
  const normalized = normalizeUsageTotals(added);

  for (const field of COUNT_FIELDS) target[field] += normalized[field];

  for (const field of COST_FIELDS) target[field] += normalized[field];
}

/** Monotone cumulative token observations; source coverage and effective cost may decrease. */
export function counterDelta(previous: ui.UsageTotals | undefined, incoming: ui.UsageTotals) {
  const next = clone(ui.UsageTotalsSchema, incoming);

  if (!previous) return { next, delta: clone(ui.UsageTotalsSchema, next) };
  const old = normalizeUsageTotals(previous);
  const grows = TOKEN_FIELDS.some((field) => incoming[field] > old[field]);
  const covers = TOKEN_FIELDS.every((field) => incoming[field] >= old[field]);

  for (const field of TOKEN_FIELDS) next[field] = old[field] > next[field] ? old[field] : next[field];

  for (const [cost, unknown] of [
    ["reportedCostUsd", "unknownCostReports"],
    ["estimatedCostUsd", "unknownEstimatedCostReports"],
  ] as const) {
    next[cost] = Math.max(old[cost], incoming[cost]);
    next[unknown] = incoming[unknown] === 0n && covers && incoming[cost] >= old[cost] ? 0n : grows ? 1n : old[unknown];
  }

  selectEffective(next);
  const delta = clone(ui.UsageTotalsSchema, next);

  for (const field of COUNT_FIELDS) delta[field] -= old[field];

  for (const field of COST_FIELDS) delta[field] -= old[field];

  return { next, delta };
}
