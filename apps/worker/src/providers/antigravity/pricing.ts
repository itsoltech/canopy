import { ModelPricingCatalog } from "../pricing/model-catalog.ts";
import { quoteAntigravity, type PricingTokens } from "../pricing/model-rates.ts";

export class AntigravityPricing {
  readonly #google: ModelPricingCatalog;
  readonly #anthropic: ModelPricingCatalog;

  constructor(dataDir: string) {
    this.#google = new ModelPricingCatalog(dataDir, "google");
    this.#anthropic = new ModelPricingCatalog(dataDir, "anthropic");
  }

  async quote(model: string, counts: PricingTokens, observedAt = Date.now()) {
    const id = model.replace(/-(?:thinking|low|medium|high|xhigh)$/, "");

    if (id.startsWith("gemini-")) {
      const key = id === "gemini-3.1-pro" ? "gemini-3.1-pro-preview" : id;
      await this.#google.prepare(key);
      const rates = this.#google.get(key);

      return rates && quoteAntigravity(rates, counts, observedAt);
    }

    if (id.startsWith("claude-")) {
      const key = id.replace(/\.(?=\d)/g, "-");
      await this.#anthropic.prepare(key);
      const rates = this.#anthropic.get(key);

      // ACP reports cache-write tokens without an expiry. Estimate using the Anthropic API default.
      return rates && quoteAntigravity(rates, counts, observedAt, "5m");
    }

    return undefined;
  }
}
