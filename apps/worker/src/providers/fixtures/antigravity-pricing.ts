import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const carbonPriceFixture = `schema = 2
base_model = "google/gemini-4-carbon"
[cost.text.input]
price = 2
cache = { read = 0.1 }
[cost.text.output]
price = 10
[[cost.multipliers]]
when = { service_tier = { equals = "priority" } }
factor = { text = 1.8, audio = 1.8 }
[[cost.multipliers]]
when = { date = { gte = "2026-12-01" } }
factor = { text = 2, audio = 2 }
`;

export function cacheAntigravityPricing(
  dataDir: string,
  provider: "google" | "anthropic",
  models: Record<string, string>,
) {
  const pricingDir = join(dataDir, "pricing");
  mkdirSync(pricingDir, { recursive: true });

  const entries = Object.entries(models).map(([id, text]) => ({
    id,
    text,
    retryAt: Date.now() + 86_400_000,
    sourceDate: "2026-11-25",
  }));

  writeFileSync(join(pricingDir, `${provider}.json`), JSON.stringify({ schema: 1, cooldown: 0, entries }));
}
