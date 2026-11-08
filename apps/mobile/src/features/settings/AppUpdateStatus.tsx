import * as Updates from "expo-updates";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { UpdateRow } from "../updates/UpdateRow";
import { CANOPY_VERSION } from "../../version";

export function AppUpdateStatus({ compact = false }: { compact?: boolean }) {
  const status = Updates.useUpdates();
  const channel = Updates.channel?.replace(/^./, (letter) => letter.toUpperCase()) ?? "Development";
  const update = Updates.isEmbeddedLaunch ? "Bundled" : Updates.updateId?.slice(0, 8);
  const date = Updates.createdAt?.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const value = Updates.isEnabled ? [channel, update, date].filter(Boolean).join(" · ") : "Development build";

  const error = status.checkError || status.downloadError;

  const phase = error
    ? "Failed"
    : status.isUpdatePending
      ? "Ready"
      : status.isDownloading
        ? "Downloading…"
        : status.isChecking
          ? "Checking…"
          : status.isUpdateAvailable
            ? "Available"
            : "Up to date";

  if (compact)
    return (
      <UpdateRow
        name="Canopy on this phone"
        version={CANOPY_VERSION}
        checkedAt={status.lastCheckForUpdateTimeSinceRestart?.getTime() ?? 0}
        status={Updates.isEnabled ? phase : "Development build"}
        busy={status.isChecking || status.isDownloading}
        failed={!!error}
        reason={
          error
            ? `${error.message}\nClose and reopen Canopy to retry.`
            : `${value}. Updates apply after you close and reopen Canopy.`
        }
      />
    );

  return (
    <SettingsGroup title="About">
      <SettingsValue title="Updates" value={value} description="Updates apply after you close and reopen Canopy." />
    </SettingsGroup>
  );
}
