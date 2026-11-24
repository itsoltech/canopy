import { onMount } from "svelte";
import type { SettingsSection } from "@canopy/ui/settings";
import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
import { memorySettingsPath, pendingHabitCount } from "#lib/features/memory/habit-suggestions.svelte.ts";
import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
import { hasCliUpdates } from "#lib/features/workers/cli-tools.svelte.ts";
import { useSettings } from "./settings-state.svelte.ts";
import { desktopSettingsSections, settingsSectionEnabled, settingsSections } from "./sections.ts";
import { useSettingsRoute } from "./settings-route.ts";

/**
 * The settings sections this app and gateway offer, which one is open, and which wait for the user (agent
 * CLI updates on workers): what both the side nav and the narrow-screen section menu show.
 */
export function useSettingsSections() {
  const settings = useSettings();
  const capabilities = useGatewayCapabilities();
  const overview = useOverview();
  const route = useSettingsRoute();
  let desktop = $state(false);

  onMount(() => {
    desktop = Boolean(window.canopyDesktop);
  });

  const sections = $derived<readonly SettingsSection[]>([
    ...settingsSections.filter(
      (section) =>
        settingsSectionEnabled(section.href, settings.enabledModules) && (capabilities?.supports(section.href) ?? true),
    ),
    ...(desktop ? desktopSettingsSections : []),
  ]);

  const hinted = $derived(new Set(overview && hasCliUpdates(overview.workers) ? ["/settings/workers"] : []));

  const isActive = (href: string) => route.url.pathname === href || route.url.pathname.startsWith(`${href}/`);

  return {
    get all() {
      return sections;
    },
    get current() {
      return sections.find((section) => isActive(section.href));
    },
    get habitCount() {
      return sections.some((section) => section.href === memorySettingsPath) ? pendingHabitCount(overview) : 0;
    },
    isActive,
    hinted: (href: string) => hinted.has(href),
  };
}
