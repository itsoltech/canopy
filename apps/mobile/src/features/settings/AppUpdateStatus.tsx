import { Text, View } from "react-native";
import { styles, useColors } from "../../ui/theme";
import * as Updates from "expo-updates";
import { Button, Notice } from "../../ui/components";
import { UpdateRow, type UpdateRowAction } from "../updates/UpdateRow";
import { usePhoneUpdates } from "../updates/phone";
import { useWhatsNew } from "../updates/whats-new";
import { PhoneReleaseNotes, phoneReleaseVersion } from "../updates/PhoneReleaseNotes";
import { CANOPY_VERSION } from "../../version";

const channel = Updates.channel?.replace(/^./, (letter) => letter.toUpperCase()) || "Development";

export function AppUpdateStatus() {
  const phone = usePhoneUpdates();
  const c = useColors();
  const { status } = phone;

  const update = Updates.isEmbeddedLaunch ? "Bundled" : Updates.updateId?.slice(0, 8);
  const date = Updates.createdAt?.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const value = Updates.isEnabled ? [channel, update, date].filter(Boolean).join(" · ") : "Development build";

  const candidate = phoneUpdateCandidate(status);
  const target = candidate ? phoneReleaseVersion(candidate) : undefined;

  const error =
    phone.error ||
    (status.checkError || status.downloadError ? "Phone update failed. Check your connection and retry." : "");

  // The shared row words (update-status.ts); a check keeps the settled word, the header shows it.
  const phase = error
    ? "failed"
    : phone.pending === "apply" || status.isRestarting
      ? "restarting"
      : status.isUpdatePending
        ? phone.deferred
          ? "Next launch"
          : "downloaded"
        : phone.pending === "fetch" || status.isDownloading
          ? "updating"
          : status.isUpdateAvailable
            ? "available"
            : status.lastCheckForUpdateTimeSinceRestart
              ? "current"
              : "Not checked";

  const main: UpdateRowAction | undefined = status.isUpdatePending
    ? { icon: "power", label: "Restart to update", disabled: phone.busy, run: () => void phone.apply() }
    : status.isUpdateAvailable
      ? { icon: "arrow-down-tray", label: "Download update", disabled: phone.busy, run: () => void phone.fetch() }
      : undefined;

  return (
    <>
      <UpdateRow
        name="Canopy on this phone"
        version={CANOPY_VERSION}
        target={target ?? (candidate?.type === Updates.UpdateInfoType.ROLLBACK ? "Bundled update" : undefined)}
        status={Updates.isEnabled ? phase : "Development build"}
        line={phone.deferred && !phone.notice ? "Applies the next time you launch Canopy." : undefined}
        error={error || undefined}
        busy={phone.busy}
        progress={
          status.isDownloading && status.downloadProgress !== undefined ? status.downloadProgress * 100 : undefined
        }
        action={Updates.isEnabled ? main : undefined}
      />
      {Updates.isEnabled && (
        <View style={{ gap: 8, paddingBottom: 8 }}>
          <Text style={[styles.overlayMeta, { color: c.muted }]}>{value}</Text>
          {phone.notice ? <Notice>{phone.notice}</Notice> : null}
          {status.isUpdatePending && !phone.deferred && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button title="Apply next launch" size="sm" variant="ghost" disabled={phone.busy} onPress={phone.defer} />
            </View>
          )}
        </View>
      )}
    </>
  );
}

function phoneUpdateCandidate(status: ReturnType<typeof usePhoneUpdates>["status"]) {
  return status.isUpdatePending
    ? status.downloadedUpdate
    : status.isUpdateAvailable
      ? status.availableUpdate
      : undefined;
}

export function AppUpdateReleases() {
  const notes = useWhatsNew();
  const { status } = usePhoneUpdates();
  const candidate = phoneUpdateCandidate(status);

  return (
    <>
      <Button
        title="See what's new"
        size="sm"
        variant="ghost"
        style={{ alignSelf: "flex-start" }}
        onPress={notes.show}
      />
      {Updates.isEnabled && candidate && (
        <PhoneReleaseNotes version={phoneReleaseVersion(candidate)} channel={channel} />
      )}
    </>
  );
}
