import { browser } from "$app/env";
import { desktopSettingsNavigation, settingsSectionEnabled, settingsSections } from "@canopy/ui/settings";
import type { GatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

export * from "@canopy/ui/settings";

export function webSettingsSections(modules: readonly string[], capabilities?: GatewayCapabilities) {
  const sections = browser && window.canopyDesktop ? desktopSettingsNavigation(modules) : settingsSections;

  return sections.filter(
    (section) => settingsSectionEnabled(section.href, modules) && (capabilities?.supports(section.href) ?? true),
  );
}
