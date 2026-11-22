import { z } from "zod";
import { createHash } from "node:crypto";

const price = z.number().finite().nonnegative();
const cache = z.object({ read: price.optional(), write: z.record(z.string(), price).optional() }).strict();
const count = z.number().int().nonnegative();

const context = z
  .union([z.object({ gt: count }).strict(), z.object({ gte: count }).strict()])
  .transform((condition) => ("gt" in condition ? condition.gt + 1 : condition.gte));

const override = z.object({ when: z.object({ context }).strict(), price, cache: cache.optional() }).strict();
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

const region = z.object({ region: z.object({ equals: z.string() }).strict() }).strict();
const regional = z.union([region, z.object({ not: region }).strict()]);

const multiplier = z.object({ when: z.union([tier, regional]), factor: z.object({ text: price }).strict() }).strict();

const model = z.object({
  schema: z.literal(2),
  base_model: z.string().optional(),
  cost: z.object({
    text: z.object({ input: rate, output: rate }).strict(),
    multipliers: z.array(multiplier).default([]),
  }),
});

export interface FrozenModelRates {
  model: string;
  source: string;
  sourceDate: string;
  hash: string;
  rates: z.infer<typeof model>;
}

interface PricingTokens {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningOutputTokens: number;
}

export interface ApiQuote {
  usd: number;
  version: string;
}

export function rateHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function parseModelRates(text: string, provider: string): FrozenModelRates["rates"] {
  const result = model.parse(Bun.TOML.parse(text));

  // A file may inherit a base model, but never a different provider's price table.
  if (result.base_model && !result.base_model.startsWith(`${provider}/`)) throw new Error("foreign model");

  return result;
}

function contextual(rates: z.infer<typeof rate>, tokens: number) {
  const matches = rates.overrides.filter((rule) => tokens >= rule.when.context);

  return matches.sort((a, b) => b.when.context - a.when.context)[0] ?? rates;
}

/** Prices one response only. Reasoning is already included in output; cache counters are input subsets. */
export function quoteOpenAi(
  frozen: FrozenModelRates,
  usage: PricingTokens,
  requestedTier: string,
  observedAt: number,
): ApiQuote | undefined {
  if (!validTokenUsage(usage) || !requestedTier) return undefined;
  const input = contextual(frozen.rates.cost.text.input, usage.inputTokens);
  const output = contextual(frozen.rates.cost.text.output, usage.inputTokens);
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
  const usd = tokenCost(usage, input, output, rule?.factor.text ?? 1);

  return apiQuote(frozen, usd, {
    tier: requestedTier,
    effectiveDate: rule && "service_tier" in rule.when && rule.when.date ? asOf : undefined,
  });
}

/** Grok exposes prompt totals across API calls, so quote the standard base token rates. */
export function quoteXai(frozen: FrozenModelRates, usage: PricingTokens): ApiQuote | undefined {
  if (!validTokenUsage(usage)) return undefined;
  const { input, output } = frozen.rates.cost.text;

  return apiQuote(frozen, tokenCost(usage, input, output, 1), { tier: "default", basis: "base-token-rates" });
}

function tokenCost(
  { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens }: PricingTokens,
  input: Pick<z.infer<typeof rate>, "price" | "cache">,
  output: Pick<z.infer<typeof rate>, "price">,
  factor: number,
): number | undefined {
  if (cachedInputTokens > 0 && input.cache?.read === undefined) return undefined;
  // Neither harness reports a cache-write TTL.
  const writes = [...new Set(Object.values(input.cache?.write ?? {}))];

  if (cacheWriteInputTokens > 0 && writes.length !== 1) return undefined;

  return (
    (((inputTokens - cachedInputTokens - cacheWriteInputTokens) * input.price +
      cachedInputTokens * (input.cache?.read ?? 0) +
      cacheWriteInputTokens * (writes[0] ?? 0) +
      outputTokens * output.price) *
      factor) /
    1_000_000
  );
}

function apiQuote(
  frozen: FrozenModelRates,
  usd: number | undefined,
  details: { tier: string; effectiveDate?: string | undefined; basis?: "base-token-rates" },
): ApiQuote | undefined {
  if (usd === undefined || !Number.isFinite(usd)) return undefined;

  return {
    usd,
    version: JSON.stringify({
      source: frozen.source,
      hash: frozen.hash,
      date: frozen.sourceDate,
      ...details,
    }),
  };
}

export function validTokenUsage(usage: PricingTokens): boolean {
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
