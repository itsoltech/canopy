import type { PromptEvent } from "@canopy/acp";
import { Option, Schema } from "effect";
import { emptyUsage, reportedUsd, tokenCount, type ConsumedUsage } from "../token-usage.ts";
import type { XaiPricingCatalog } from "../pricing/model-catalog.ts";
import { quoteXai } from "../pricing/model-rates.ts";

const Counters = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cachedReadTokens: Schema.optionalKey(Schema.Number),
  cacheCreationTokens: Schema.optionalKey(Schema.Number),
  reasoningTokens: Schema.optionalKey(Schema.Number),
});

const completion = Schema.decodeUnknownOption(
  Schema.Struct({
    _meta: Schema.optionalKey(
      Schema.Struct({
        modelId: Schema.optionalKey(Schema.String),
        usage: Schema.optionalKey(
          Schema.Struct({
            ...Counters.fields,
            modelUsage: Schema.optionalKey(Schema.Record(Schema.String, Counters)),
          }),
        ),
      }),
    ),
  }),
);

/** Grok 1.0.70 reports consumed tokens per prompt in _meta.usage, including cancelled prompts. */
export type GrokCompletion = Extract<PromptEvent, { type: "complete" }>;

export async function grokPromptUsage(
  event: GrokCompletion,
  cost?: number,
  pricing?: XaiPricingCatalog,
): Promise<ConsumedUsage[]> {
  const meta = Option.getOrUndefined(completion(event))?._meta;

  if (!meta?.usage) return [];
  const perModel = Object.entries(meta.usage.modelUsage ?? {});
  const models = perModel.length ? perModel : [[meta.modelId ?? "", meta.usage] as const];

  return Promise.all(
    models.map(async ([model, usage]) => {
      const counts = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedReadTokens ?? 0,
        cacheWriteInputTokens: usage.cacheCreationTokens ?? 0,
        reasoningOutputTokens: usage.reasoningTokens ?? 0,
      };

      await pricing?.prepare(model);
      const rates = pricing?.get(model);
      const quote = rates && quoteXai(rates, counts);

      return {
        ...emptyUsage(),
        inputTokens: tokenCount(counts.inputTokens),
        outputTokens: tokenCount(counts.outputTokens),
        cachedInputTokens: tokenCount(counts.cachedInputTokens),
        cacheWriteInputTokens: tokenCount(counts.cacheWriteInputTokens),
        reasoningOutputTokens: tokenCount(counts.reasoningOutputTokens),
        model,
        requestedServiceTier: "default",
        reportedCostUsd: models.length === 1 ? cost : undefined,
        ...(quote && { estimatedCostUsd: quote.usd, pricingVersion: quote.version }),
      };
    }),
  );
}

/** ACP UsageUpdate.cost is a cumulative session amount; unknown resumed baselines are never charged. */
export class GrokSessionCost {
  #previous: number | undefined;
  #baseline: number | undefined;

  constructor(resumed = false) {
    this.#previous = resumed ? undefined : 0;
  }

  beginTurn(): void {
    this.#baseline = this.#previous;
  }

  observe(cost: { amount: number; currency: string } | undefined): number | undefined {
    if (cost?.currency !== "USD") return undefined;
    const current = reportedUsd(cost.amount);

    if (current === undefined) return undefined;
    this.#previous = current;

    if (this.#baseline === undefined) return undefined;

    if (current < this.#baseline) this.#baseline = 0;

    return current - this.#baseline;
  }
}
