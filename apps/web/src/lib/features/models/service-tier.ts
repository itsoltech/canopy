import type { ModelOption } from "./catalog.ts";

/** Empty means inherit. An unavailable account speed resets when the model changes. */
export function supportedServiceTier(option: ModelOption | undefined, value: string | undefined): string {
  return value && option && (value === "default" || option.serviceTiers.some((tier) => tier.id === value)) ? value : "";
}
