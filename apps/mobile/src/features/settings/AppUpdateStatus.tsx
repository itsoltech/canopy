import * as Updates from "expo-updates";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";

export function AppUpdateStatus() {
  const channel = Updates.channel?.replace(/^./, (letter) => letter.toUpperCase()) ?? "Development";
  const update = Updates.isEmbeddedLaunch ? "Bundled" : Updates.updateId?.slice(0, 8);
  const date = Updates.createdAt?.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const value = Updates.isEnabled ? [channel, update, date].filter(Boolean).join(" · ") : "Development build";

  return (
    <SettingsGroup title="About">
      <SettingsValue title="Updates" value={value} description="Updates apply after you close and reopen Canopy." />
    </SettingsGroup>
  );
}
