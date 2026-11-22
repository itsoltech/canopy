import { join } from "node:path";

export const xaiPriceFixture = `
schema = 2
base_model = "xai/grok-4.6"
[cost.text.input]
price = 2
cache = { read = 0.5 }
[[cost.text.input.overrides]]
when = { context = { gte = 200_000 } }
price = 4
cache = { read = 1 }
[cost.text.output]
price = 6
[[cost.text.output.overrides]]
when = { context = { gte = 200_000 } }
price = 12
[[cost.multipliers]]
when = { region = { equals = "us" } }
factor = { text = 1.1 }
`;

export async function cacheXaiPriceFixture(dataDir: string): Promise<void> {
  await Bun.write(
    join(dataDir, "pricing", "xai.json"),
    JSON.stringify({
      schema: 1,
      cooldown: 0,
      entries: [{ id: "grok-4.6", retryAt: Date.now() + 86_400_000, text: xaiPriceFixture, sourceDate: "2026-11-22" }],
    }),
    { createPath: true },
  );
}
