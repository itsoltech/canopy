import { z } from "zod";
import { createHash } from "node:crypto";
import type { v2 } from "@canopy/codex-protocol";

const price = z.number().finite().nonnegative();
const cache = z.object({ read: price.optional(), write: z.record(z.string(), price).optional() }).strict();
const context = z.object({ context: z.object({ gt: z.number().int().nonnegative() }).strict() }).strict();
const override = z.object({ when: context, price, cache: cache.optional() }).strict();
const rate = z.object({ price, cache: cache.optional(), overrides: z.array(override).default([]) }).strict();

const dateCondition = z
  .object({ lt: z.iso.date().optional(), gte: z.iso.date().optional() })
  .strict()
  .refine((condition) => !!condition.lt || !!condition.gte);

const tier = z
  .object({ service_tier: z.object({ equals: z.string() }).strict(), date: dateCondition.optional() })
  .strict();

const pacificDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const regional = z
  .object({ not: z.object({ region: z.object({ equals: z.literal("global") }).strict() }).strict() })
  .strict();

const multiplier = z.object({ when: z.union([tier, regional]), factor: z.object({ text: price }).strict() }).strict();

const model = z.object({
  schema: z.literal(2),
  base_model: z.string().optional(),
  cost: z.object({
    text: z.object({ input: rate, output: rate }).strict(),
    multipliers: z.array(multiplier).default([]),
  }),
});

export type OpenAiRates = z.infer<typeof model>;

export interface FrozenOpenAiRates {
  model: string;
  source: string;
  sourceDate: string;
  hash: string;
  rates: OpenAiRates;
}

export interface ApiQuote {
  usd: number;
  version: string;
}

export function rateHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function parseOpenAiRates(text: string, id: string): OpenAiRates {
  const result = model.parse(Bun.TOML.parse(text));

  // A file may inherit a base model, but never a different provider's price table.
  if (result.base_model && !result.base_model.startsWith("openai/")) throw new Error("non-OpenAI model");

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(id)) throw new Error("invalid OpenAI model id");

  return result;
}

function contextual(rates: z.infer<typeof rate>, tokens: number) {
  const matches = rates.overrides.filter((rule) => tokens > rule.when.context.gt);

  return matches.sort((a, b) => b.when.context.gt - a.when.context.gt)[0] ?? rates;
}

/** Prices one response only. Reasoning is already included in output; cache counters are input subsets. */
export function quoteOpenAi(
  frozen: FrozenOpenAiRates,
  usage: v2.TokenUsageBreakdown,
  requestedTier: string,
  observedAt: number,
): ApiQuote | undefined {
  if (!validOpenAiUsage(usage)) return undefined;
  const { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens } = usage;
  const input = contextual(frozen.rates.cost.text.input, inputTokens);
  const output = contextual(frozen.rates.cost.text.output, inputTokens);

  if (!requestedTier) return undefined;
  const serviceTier = requestedTier === "fast" ? "priority" : requestedTier;
  const parts = pacificDate.formatToParts(observedAt);
  const datePart = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const asOf = `${datePart("year")}-${datePart("month")}-${datePart("day")}`;

  const rule = frozen.rates.cost.multipliers.find(
    (entry) =>
      "service_tier" in entry.when &&
      entry.when.service_tier.equals === serviceTier &&
      (!entry.when.date?.lt || asOf < entry.when.date.lt) &&
      (!entry.when.date?.gte || asOf >= entry.when.date.gte),
  );

  if (serviceTier !== "default" && !rule) return undefined;

  if (cachedInputTokens > 0 && input.cache?.read === undefined) return undefined;
  // Codex reports no cache-write TTL. Only a TTL-independent rate can cover writes safely.
  const writes = [...new Set(Object.values(input.cache?.write ?? {}))];

  if (cacheWriteInputTokens > 0 && writes.length !== 1) return undefined;

  const usd =
    (((inputTokens - cachedInputTokens - cacheWriteInputTokens) * input.price +
      cachedInputTokens * (input.cache?.read ?? 0) +
      cacheWriteInputTokens * (writes[0] ?? 0) +
      outputTokens * output.price) *
      (rule?.factor.text ?? 1)) /
    1_000_000;

  if (!Number.isFinite(usd)) return undefined;

  return {
    usd,
    version: JSON.stringify({
      source: frozen.source,
      hash: frozen.hash,
      date: frozen.sourceDate,
      tier: requestedTier,
      effectiveDate: rule && "service_tier" in rule.when && rule.when.date ? asOf : undefined,
    }),
  };
}

export function validOpenAiUsage(usage: v2.TokenUsageBreakdown): boolean {
  const counts = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteInputTokens,
    usage.reasoningOutputTokens,
  ];

  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) return false;

  return (
    usage.cachedInputTokens + usage.cacheWriteInputTokens <= usage.inputTokens &&
    usage.reasoningOutputTokens <= usage.outputTokens
  );
}
