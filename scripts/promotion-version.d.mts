import type { PromotionInput, PromotionPlan } from "./promotion-policy.ts";

export function forecastPromotion(
  input: PromotionInput,
  plan: PromotionPlan,
  git: (...args: string[]) => string,
): Promise<string | undefined>;

export function forecastPromotionWindow(
  input: PromotionInput,
  plan: PromotionPlan,
  git: (...args: string[]) => string,
): Promise<{ at: number; sha: string; version: string } | undefined>;
