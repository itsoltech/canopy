import { router, type NavigationState } from "expo-router";

/** The section picker opens the unscoped panel. Its URL and scroll position exclude the shortcut filters. */
export function settingsScope(params: NavigationState["routes"][number]["params"]) {
  return Object.entries(params ?? {})
    .filter(([name]) => name !== "section")
    .sort(([left], [right]) => left.localeCompare(right));
}

/** Section shortcuts keep General underneath, including entry from a chat. */
export function openSettingsSection(section: string, scope: Record<string, string> = {}) {
  router.push({ pathname: "/settings/[section]", params: { ...scope, section } }, { withAnchor: true });
}
