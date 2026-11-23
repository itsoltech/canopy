import { createContext, useContext } from "react";
import type { ui } from "@canopy/contracts";
import { settingsSectionEnabled, settingsSectionMethods, settingsSections } from "@canopy/ui/settings";
import { useAppearance } from "../../state/appearance";
import { useSettingsResource } from "./resource";

const mobileSections = settingsSections.map((section) =>
  section.href === "/settings/general"
    ? { ...section, keywords: `${section.keywords} privacy analytics telemetry usage ping` }
    : section,
);

const methods = new Map<string, readonly string[]>(Object.entries(settingsSectionMethods));

function mobileSectionSupported(href: string, capabilities?: ui.ClientCapabilities) {
  // This phone's pairing and local removal stay accessible even on older gateways.
  if (href === "/settings/mobile") return true;

  if (href === "/settings/computers" && !capabilities?.linkedComputers) return false;

  if (!capabilities) return href !== "/settings/memory" && href !== "/settings/agent-tools";

  return methods.get(href)?.every((method) => capabilities.methods.includes(method)) ?? true;
}

export function useSettingsCatalog() {
  const { modules } = useAppearance();
  const resource = useSettingsResource("GetClientCapabilities", (api) => api.getClientCapabilities({}));
  const sections = mobileSections.filter((section) => settingsSectionEnabled(section.href, modules));

  return {
    sections,
    available: sections.filter((section) => mobileSectionSupported(section.href, resource.data)),
    waitingFor: (href: string) => resource.initialLoading && href !== "/settings/mobile" && methods.has(href),
    error: resource.error,
    retry: resource.reload,
  };
}

export const SettingsCatalog = createContext<ReturnType<typeof useSettingsCatalog> | null>(null);

export function useSectionAvailability() {
  const catalog = useContext(SettingsCatalog);

  if (!catalog) throw new Error("Missing SettingsCatalog");

  return catalog;
}
