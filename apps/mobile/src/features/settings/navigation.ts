import { router, useNavigationContainerRef, type Href, type NavigationState } from "expo-router";
import { useCallback } from "react";

/** The section picker opens the unscoped panel. Its URL and scroll position exclude the shortcut filters. */
export function settingsScope(params: NavigationState["routes"][number]["params"]) {
  return Object.entries(params ?? {})
    .filter(([name]) => name !== "section")
    .sort(([left], [right]) => left.localeCompare(right));
}

function settingsOpen(state: NavigationState["routes"][number]["state"]): boolean {
  const route = state?.routes[state.index ?? 0];

  return Boolean(route && (route.name === "settings" || settingsOpen(route.state)));
}

export function useOpenSettingsSection() {
  const navigation = useNavigationContainerRef();

  return useCallback(
    (section: string, scope: Record<string, string> = {}) => {
      const href: Href =
        section === "general" ? "/settings" : { pathname: "/settings/[section]", params: { ...scope, section } };

      // Read the active route at press time. Shortcuts can also come from an app-wide notification.
      if (settingsOpen(navigation.getRootState())) router.replace(href);
      else router.push(href);
    },
    [navigation],
  );
}
