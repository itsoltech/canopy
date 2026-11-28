import { browser } from "$app/env";
import { rendererSettingsNavigation, settingsSectionEnabled } from "@canopy/ui/settings";
import type { GatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

export * from "@canopy/ui/settings";

export function webSettingsSections(modules: readonly string[], capabilities?: GatewayCapabilities) {
  const sections = rendererSettingsNavigation(browser && window.canopyDesktop ? "desktop" : "web", modules);

  return sections.filter(
    (section) => settingsSectionEnabled(section.href, modules) && (capabilities?.supports(section.href) ?? true),
  );
}
