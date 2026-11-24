import { formatCount } from "#lib/shared/format.ts";

const dollars = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 });

export const habitExamples = (count: number): string => `${formatCount(count)} ${count === 1 ? "example" : "examples"}`;

export const habitSuggestionCount = (count: number): string =>
  `${formatCount(count)} habit ${count === 1 ? "suggestion" : "suggestions"} to review`;

export const habitReportedCost = (usd: number): string =>
  usd > 0 && usd < 0.0001 ? `<${dollars.format(0.0001)}` : dollars.format(usd);
