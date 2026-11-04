import type { PromotionInput, PromotionPlan } from "./promotion-policy.ts";

export function forecastPromotion(
  input: PromotionInput,
  plan: PromotionPlan,
  git: (...args: string[]) => string,
): Promise<string | undefined>;
