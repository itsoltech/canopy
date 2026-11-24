import { providerColors, usageSeriesColor } from "@canopy/ui/provider-icons";
import type { ProviderKey } from "#lib/features/threads/providers.ts";

/** Logos retain their original colours; chart series use separate muted tones. */
const providers = new Map<string, { icon: ProviderKey; color: string }>([
  ["claude", { icon: "CLAUDE", color: providerColors.CLAUDE }],
  ["codex", { icon: "CODEX", color: "#09090b" }],
  ["grok", { icon: "GROK", color: "#ffffff" }],
  ["antigravity", { icon: "ANTIGRAVITY", color: "#ffffff" }],
]);

export const usageProvider = (provider: string) => providers.get(provider);

export const usageProviderColor = (provider: string) =>
  `light-dark(${usageSeriesColor(provider, "light")}, ${usageSeriesColor(provider, "dark")})`;
