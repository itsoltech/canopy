import { providerColors } from "@canopy/ui/provider-icons";
import type { ProviderKey } from "#lib/features/threads/providers.ts";

/** Logos retain their original colours; chart series use separate muted tones. */
const providers = new Map<string, { icon: ProviderKey; color: string }>([
  ["claude", { icon: "CLAUDE", color: providerColors.CLAUDE }],
  ["codex", { icon: "CODEX", color: "#09090b" }],
  ["grok", { icon: "GROK", color: "#ffffff" }],
]);

export const usageProvider = (provider: string) => providers.get(provider);

const chartColors = new Map([
  ["claude", "light-dark(#c47759, #db9a7e)"],
  ["codex", "light-dark(#647985, #91a9b4)"],
  ["grok", "light-dark(#91816b, #c9bca3)"],
]);

export const usageProviderColor = (provider: string) => chartColors.get(provider) ?? "#a1a1aa";
