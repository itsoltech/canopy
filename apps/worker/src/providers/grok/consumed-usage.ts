import type { PromptEvent } from "@canopy/grok-acp";
import { Option, Schema } from "effect";
import { emptyUsage, reportedUsd, tokenCount, type ConsumedUsage } from "../token-usage.ts";

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

export function grokPromptUsage(event: GrokCompletion): ConsumedUsage[] {
  const meta = Option.getOrUndefined(completion(event))?._meta;

  if (!meta?.usage) return [];
  const models = meta.usage.modelUsage ?? { [meta.modelId ?? ""]: meta.usage };

  return Object.entries(models).map(([model, usage]) => ({
    ...emptyUsage(),
    inputTokens: tokenCount(usage.inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    cachedInputTokens: tokenCount(usage.cachedReadTokens),
    cacheWriteInputTokens: tokenCount(usage.cacheCreationTokens),
    reasoningOutputTokens: tokenCount(usage.reasoningTokens),
    model,
  }));
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
