import { clone, create } from "@bufbuild/protobuf";
import { ui, type Usage } from "@canopy/contracts";

export const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "reasoningOutputTokens",
] as const;

export const COUNT_FIELDS = [...TOKEN_FIELDS, "reports", "unknownCostReports"] as const;

export function usageTotals(usage: Usage): ui.UsageTotals {
  const cost = usage.reportedCostUsd;
  const known = cost !== undefined && Number.isFinite(cost) && cost >= 0;

  return create(ui.UsageTotalsSchema, {
    inputTokens:
      usage.inputTokens > usage.cachedInputTokens + usage.cacheWriteInputTokens
        ? usage.inputTokens
        : usage.cachedInputTokens + usage.cacheWriteInputTokens,
    outputTokens: usage.outputTokens > usage.reasoningOutputTokens ? usage.outputTokens : usage.reasoningOutputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    reportedCostUsd: known ? cost : 0,
    reports: 1n,
    unknownCostReports: known ? 0n : 1n,
  });
}

export function addTotals(target: ui.UsageTotals, added: ui.UsageTotals): void {
  for (const field of COUNT_FIELDS) target[field] += added[field];
  target.reportedCostUsd += added.reportedCostUsd;
}

/** Monotone cumulative observations: delayed smaller snapshots never subtract consumption. */
export function counterDelta(previous: ui.UsageTotals | undefined, incoming: ui.UsageTotals) {
  const next = clone(ui.UsageTotalsSchema, incoming);
  const delta = clone(ui.UsageTotalsSchema, incoming);

  if (previous) {
    for (const field of TOKEN_FIELDS) {
      next[field] = previous[field] > next[field] ? previous[field] : next[field];
      delta[field] = next[field] - previous[field];
    }

    next.reportedCostUsd = Math.max(previous.reportedCostUsd, next.reportedCostUsd);
    const grows = TOKEN_FIELDS.some((field) => incoming[field] > previous[field]);
    const covers = TOKEN_FIELDS.every((field) => incoming[field] >= previous[field]);
    next.unknownCostReports =
      incoming.unknownCostReports === 0n && covers && incoming.reportedCostUsd >= previous.reportedCostUsd
        ? 0n
        : grows
          ? 1n
          : previous.unknownCostReports;
    delta.reportedCostUsd = next.reportedCostUsd - previous.reportedCostUsd;
    delta.reports = 0n;
    delta.unknownCostReports = next.unknownCostReports - previous.unknownCostReports;
  }

  return { next, delta };
}
