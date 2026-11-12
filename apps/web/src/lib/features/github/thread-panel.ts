import { page } from "$app/state";
import { goto } from "$app/navigation";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";

export function closePullRequest() {
  const url = new URL(page.url.href);
  url.searchParams.delete("pr");

  return goto(`${url.pathname}${url.search}`, { reset: false });
}

export function toggleThreadPanel(open: boolean, sheet: () => void) {
  if (page.url.searchParams.has("pr")) {
    devicePreferences.setView({ threadPanelCollapsed: false });
    closePullRequest();

    return;
  }

  if (matchMedia("(min-width: 80rem)").matches) devicePreferences.setView({ threadPanelCollapsed: open });
  else sheet();
}
