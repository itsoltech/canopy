import { expect, test } from "bun:test";
import { tempDir } from "@canopy/testing";
import { cacheAntigravityPricing, carbonPriceFixture } from "../fixtures/antigravity-pricing.ts";
import { AntigravityEventMapper } from "./mapping.ts";
import { AntigravityPricing } from "./pricing.ts";

const geminiProRates = `schema = 2
[cost.text.input]
price = 2
cache = { read = 0.2, storage = 4.5 }
[[cost.text.input.overrides]]
when = { context = { gt = 200_000 } }
price = 4
cache = { read = 0.4 }
[cost.text.output]
price = 12
[[cost.text.output.overrides]]
when = { context = { gt = 200_000 } }
price = 18
[[cost.multipliers]]
when = { service_tier = { equals = "flex" } }
factor = { text = { input = { price = 0.5 }, output = { price = 0.5 } } }
`;

const claudeRates = `schema = 2
[cost.text.input]
price = 4
cache = { read = 0.2, write = { "5m" = 5, "1h" = 8 } }
[cost.text.output]
price = 20
[[cost.multipliers]]
when = { region = { equals = "us" } }
factor = { text = 1.1 }
`;

test("Antigravity uses Gemini calendar prices and preserves unknown estimates for unpriced usage", async () => {
  const dataDir = tempDir("canopy-agy-rates-");
  cacheAntigravityPricing(dataDir, "google", { "gemini-4-carbon": carbonPriceFixture });
  const pricing = new AntigravityPricing(dataDir);

  const counts = {
    inputTokens: 200_000,
    outputTokens: 50_000,
    cachedInputTokens: 50_000,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 30_000,
  };

  const before = Date.parse("2026-11-30T23:59:59Z");
  const after = Date.parse("2026-12-01T00:00:00Z");

  expect(await pricing.quote("gemini-4-carbon", counts, before)).toMatchObject({ usd: 0.805 });
  expect(await pricing.quote("gemini-4-carbon", counts, after)).toMatchObject({
    usd: 1.61,
    version: expect.stringContaining('"effectiveDate":"2026-12-01"'),
  });

  expect(await pricing.quote("gemini-4-carbon", { ...counts, cacheWriteInputTokens: 1 }, after)).toBeUndefined();
  expect(await pricing.quote("gemini-4-carbon", { ...counts, reasoningOutputTokens: 60_000 }, after)).toBeUndefined();
  expect(await pricing.quote("orchestrator", counts, after)).toBeUndefined();
});

test("Antigravity prices ACP prompt totals using model aliases, cache subsets and total output", async () => {
  const dataDir = tempDir("canopy-agy-prompt-rates-");
  cacheAntigravityPricing(dataDir, "google", { "gemini-3.1-pro-preview": geminiProRates });
  cacheAntigravityPricing(dataDir, "anthropic", { "claude-opus-5-5": claudeRates });
  const pricing = new AntigravityPricing(dataDir);
  const gemini = new AntigravityEventMapper("gemini-turn", "/repo", "gemini-3.1-pro", pricing);
  const claude = new AntigravityEventMapper("claude-turn", "/repo", "claude-opus-5.5-thinking", pricing);

  const completion = {
    type: "complete",
    stopReason: "end_turn",
    usage: { inputTokens: 200_000, cachedReadTokens: 50_000, outputTokens: 50_000, thoughtTokens: 30_000 },
  } as const;

  await gemini.complete(completion);
  expect(gemini.usage).toMatchObject([
    {
      model: "gemini-3.1-pro",
      inputTokens: 250_000n,
      cachedInputTokens: 50_000n,
      outputTokens: 50_000n,
      reasoningOutputTokens: 30_000n,
      estimatedCostUsd: 1.01,
    },
  ]);
  expect(gemini.usage[0]?.reportedCostUsd).toBeUndefined();

  await claude.complete({ ...completion, usage: { ...completion.usage, cachedWriteTokens: 10_000 } });
  expect(claude.usage).toMatchObject([
    {
      model: "claude-opus-5.5-thinking",
      inputTokens: 260_000n,
      cacheWriteInputTokens: 10_000n,
      estimatedCostUsd: 1.86,
      pricingVersion: expect.stringContaining('"cacheWriteTtl":"5m"'),
    },
  ]);
  expect(claude.usage[0]?.reportedCostUsd).toBeUndefined();
});
