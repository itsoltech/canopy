import { router } from "expo-router";

/** Section shortcuts keep the Settings list underneath, including entry from a chat. */
export function openSettingsSection(section: string, scope: Record<string, string> = {}) {
  router.push({ pathname: "/settings/[section]", params: { ...scope, section } }, { withAnchor: true });
}
