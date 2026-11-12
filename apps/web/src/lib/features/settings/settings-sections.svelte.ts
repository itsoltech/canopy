import { onMount } from "svelte";
import type { SettingsSection } from "@canopy/ui/settings";
import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
import { hasCliUpdates } from "#lib/features/workers/cli-tools.svelte.ts";
import { settingsSections } from "./sections.ts";
import { useSettingsRoute } from "./settings-route.ts";

/** Sections only the desktop app has (its local gateway and its own updates). */
const desktopSections: readonly SettingsSection[] = [
  {
    href: "/settings/desktop",
    label: "Desktop",
    icon: "server",
    group: "Connections",
    keywords: "desktop local remote worker computer",
  },
];

/**
 * The settings sections this app and gateway offer, which one is open, and which wait for the user (agent
 * CLI updates on workers): what both the side nav and the narrow-screen section menu show.
 */
export function useSettingsSections() {
  const capabilities = useGatewayCapabilities();
  const overview = useOverview();
  const route = useSettingsRoute();
  let desktop = $state(false);

  onMount(() => {
    desktop = Boolean(window.canopyDesktop);
  });

  const sections = $derived<readonly SettingsSection[]>([
    ...settingsSections.filter((section) => capabilities?.supports(section.href) ?? true),
    ...(desktop ? desktopSections : []),
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
    isActive,
    hinted: (href: string) => hinted.has(href),
  };
}
