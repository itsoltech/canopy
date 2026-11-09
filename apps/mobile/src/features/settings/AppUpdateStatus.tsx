import { View } from "react-native";
import * as Updates from "expo-updates";
import { Button, Notice } from "../../ui/components";
import { SettingsGroup } from "./SettingsGroup";
import { UpdateRow } from "../updates/UpdateRow";
import { usePhoneUpdates } from "../updates/phone";
import { PhoneReleaseNotes, phoneReleaseVersion } from "../updates/PhoneReleaseNotes";
import { CANOPY_VERSION } from "../../version";

export function AppUpdateStatus({ compact = false }: { compact?: boolean }) {
  const phone = usePhoneUpdates();
  const { status } = phone;
  const channel = Updates.channel?.replace(/^./, (letter) => letter.toUpperCase()) ?? "Development";
  const update = Updates.isEmbeddedLaunch ? "Bundled" : Updates.updateId?.slice(0, 8);
  const date = Updates.createdAt?.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const value = Updates.isEnabled ? [channel, update, date].filter(Boolean).join(" · ") : "Development build";

  const candidate = status.isUpdatePending
    ? status.downloadedUpdate
    : status.isUpdateAvailable
      ? status.availableUpdate
      : undefined;

  const target = candidate ? phoneReleaseVersion(candidate) : undefined;

  const error =
    phone.error ||
    (status.checkError || status.downloadError ? "Phone update failed. Check your connection and retry." : "");

  const phase = error
    ? "Failed"
    : phone.pending === "apply" || status.isRestarting
      ? "Restarting…"
      : status.isUpdatePending
        ? phone.deferred
          ? "Next launch"
          : "Ready"
        : phone.pending === "fetch" || status.isDownloading
          ? "Downloading…"
          : phone.pending === "check" || status.isChecking || status.isStartupProcedureRunning
            ? "Checking…"
            : status.isUpdateAvailable
              ? "Available"
              : status.lastCheckForUpdateTimeSinceRestart
                ? "Up to date"
                : "Not checked";

  const main = status.isUpdatePending
    ? { label: "Apply update", run: () => void phone.apply() }
    : status.isUpdateAvailable
      ? { label: "Download update", run: () => void phone.fetch() }
      : { label: "Check this phone for updates", run: () => void phone.check() };

  const row = (
    <UpdateRow
      name="Canopy on this phone"
      version={CANOPY_VERSION}
      target={target ?? (candidate?.type === Updates.UpdateInfoType.ROLLBACK ? "Bundled update" : undefined)}
      checkedAt={status.lastCheckForUpdateTimeSinceRestart?.getTime() ?? 0}
      status={Updates.isEnabled ? phase : "Development build"}
      busy={phone.busy}
      failed={Boolean(error)}
      progress={
        status.isDownloading && status.downloadProgress !== undefined ? status.downloadProgress * 100 : undefined
      }
      action={Updates.isEnabled ? { ...main, disabled: phone.busy } : undefined}
      reason={error || `${value}. Downloaded updates apply the next time you launch Canopy.`}
    >
      {Updates.isEnabled && (
        <>
          {phone.notice ? <Notice>{phone.notice}</Notice> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {(status.isUpdateAvailable || status.isUpdatePending) && (
              <Button
                title="Check this phone"
                size="sm"
                variant="ghost"
                disabled={phone.busy}
                onPress={() => void phone.check()}
              />
            )}
            {status.isUpdatePending && !phone.deferred && (
              <Button title="Apply next launch" size="sm" variant="ghost" disabled={phone.busy} onPress={phone.defer} />
            )}
          </View>
          <PhoneReleaseNotes version={candidate ? target : CANOPY_VERSION} channel={channel} />
        </>
      )}
    </UpdateRow>
  );

  return compact ? row : <SettingsGroup title="About">{row}</SettingsGroup>;
}
