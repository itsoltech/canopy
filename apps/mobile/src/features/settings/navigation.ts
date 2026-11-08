import { router } from "expo-router";

/** Section shortcuts keep the Settings list underneath, including entry from a chat. */
export function openSettingsSection(section: string) {
  router.push({ pathname: "/settings/[section]", params: { section } }, { withAnchor: true });
}
