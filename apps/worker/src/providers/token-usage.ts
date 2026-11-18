import { UsageScope } from "@canopy/contracts";

/** Consumed tokens, cumulative within one platform turn. Cache and reasoning are subsets. */
export interface ConsumedUsage {
  scope: UsageScope;
  inputTokens: bigint;
  outputTokens: bigint;
  cachedInputTokens: bigint;
  cacheWriteInputTokens: bigint;
  reasoningOutputTokens: bigint;
  reportedCostUsd?: number | undefined;
  /** OpenAI API-equivalent token valuation, distinct from provider-reported billing. */
  estimatedCostUsd?: number | undefined;
  pricingVersion?: string;
  model?: string;
  /** Accepted dispatch choice, independent of actual provider billing tier. */
  requestedServiceTier?: string;
}

export const tokenFields = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "reasoningOutputTokens",
] as const;

export function emptyUsage(): ConsumedUsage {
  return {
    scope: UsageScope.TURN,
    inputTokens: 0n,
    outputTokens: 0n,
    cachedInputTokens: 0n,
    cacheWriteInputTokens: 0n,
    reasoningOutputTokens: 0n,
  };
}

export function tokenCount(value: number | null | undefined): bigint {
  return value != null && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : 0n;
}

export function reportedUsd(value: number | null | undefined): number | undefined {
  return value != null && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function addUsage(target: ConsumedUsage, source: ConsumedUsage): void {
  for (const key of tokenFields) target[key] += source[key];

  if (source.reportedCostUsd !== undefined)
    target.reportedCostUsd = (target.reportedCostUsd ?? 0) + source.reportedCostUsd;

  if (source.model) target.model = source.model;
}

export function usageDifference(current: ConsumedUsage, previous: ConsumedUsage): ConsumedUsage {
  const result = emptyUsage();

  for (const key of tokenFields)
    result[key] = current[key] >= previous[key] ? current[key] - previous[key] : current[key];

  if (current.reportedCostUsd !== undefined && previous.reportedCostUsd !== undefined)
    result.reportedCostUsd =
      current.reportedCostUsd >= previous.reportedCostUsd
        ? current.reportedCostUsd - previous.reportedCostUsd
        : current.reportedCostUsd;

  return result;
}
