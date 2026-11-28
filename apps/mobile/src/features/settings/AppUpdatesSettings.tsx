import { Text, View } from "react-native";
import * as Updates from "expo-updates";
import { gatewayUpdateLifecycle } from "@canopy/domain/release/update-status";
import { Button } from "../../ui/components";
import { ProgressBar } from "../../ui/ProgressBar";
import { styles, useColors } from "../../ui/theme";
import { updatesHeadline } from "../updates/headline";
import { bulkUpdatesAvailable } from "../updates/model";
import { usePhoneUpdates } from "../updates/phone";
import { useUpdates } from "../updates/state";
import { UpdateFeedback, UpdateRun } from "../updates/UpdateSummary";
import { UpdateRows } from "../updates/UpdateRows";
import { AppUpdateStatus, AppUpdateReleases } from "./AppUpdateStatus";
import { AutoUpdateSetting } from "./AutoUpdateSetting";
import { confirmAction } from "./resource";
import { SettingsRowContent } from "./SettingsRow";
import { SettingsGroup, SettingChoice } from "./SettingsGroup";
import { SettingsTopics } from "./SettingsTopics";

export function AppUpdatesSettings() {
  const { snapshot, active, manage } = useUpdates();

  return (
    <SettingsTopics
      topics={[
        { id: "status", label: "Status", content: <UpdateStatus /> },
        {
          id: "preferences",
          label: "Update preferences",
          hidden: !snapshot || (snapshot.gatewayBundled && !snapshot.autoUpdateSupported),
          content: snapshot && (
            <>
              <SettingsGroup title="Update preferences">
                {snapshot.autoUpdateSupported && <AutoUpdateSetting computerName={snapshot.computerName} />}
                {!snapshot.gatewayBundled && (
                  <SettingChoice
                    title="Gateway release channel"
                    value={snapshot.channel}
                    disabled={active || !snapshot.admin}
                    options={[
                      { value: "stable", label: "Stable" },
                      { value: "beta", label: "Beta" },
                      { value: "nightly", label: "Nightly" },
                    ]}
                    onChange={(channel) =>
                      confirmAction(
                        "Change release channel",
                        "A channel may contain an older version. Review the available version before installing.",
                        () => void manage({ action: "channel", channel }),
                      )
                    }
                  />
                )}
              </SettingsGroup>
              <UpdateFeedback />
            </>
          ),
        },
        { id: "releases", label: "Releases", content: <AppUpdateReleases /> },
      ]}
    />
  );
}

function UpdateStatus() {
  const { snapshot, pending, optimistic, run, active, manage } = useUpdates();
  const phone = usePhoneUpdates();
  const c = useColors();
  const checkingPhone = phone.pending === "check" || phone.status.isChecking;
  const gatewayChecking = pending === "check" || !!snapshot?.checking;
  const canCheckGateway = !pending && !gatewayChecking && !gatewayUpdateLifecycle(snapshot?.gatewayState);
  const canCheckPhone = Updates.isEnabled && !phone.busy;
  const stopped = run?.state === "failed" || run?.state === "blocked";

  const headline = updatesHeadline({
    snapshot,
    run,
    starting: !!optimistic && !!pending,
    checking: checkingPhone || gatewayChecking,
    phoneUpdate: phone.status.isUpdateAvailable || phone.status.isUpdatePending,
    phoneUpdating:
      phone.pending === "fetch" || phone.pending === "apply" || phone.status.isDownloading || phone.status.isRestarting,
  });

  return (
    <>
      <SettingsGroup
        title="Canopy versions"
        actions={
          <Button
            title="Check for updates"
            size="sm"
            disabled={!canCheckPhone && !canCheckGateway}
            busy={(checkingPhone || gatewayChecking) && !canCheckPhone && !canCheckGateway}
            onPress={() => {
              if (canCheckPhone) void phone.check();

              if (canCheckGateway) void manage({ action: "check" });
            }}
          />
        }
      >
        <View style={{ gap: 6 }}>
          {!!headline.text && (
            <SettingsRowContent
              inlineControl="wrap"
              copy={
                <Text
                  accessibilityLiveRegion="polite"
                  style={[
                    styles.workMeta,
                    { color: headline.tone === "rose" ? c.danger : headline.tone === "ink" ? c.text : c.muted },
                  ]}
                >
                  {headline.text}
                </Text>
              }
              control={
                (stopped || (snapshot && bulkUpdatesAvailable(snapshot))) && (
                  <Button
                    title={stopped ? "Retry failed" : "Update all"}
                    size="sm"
                    variant="primary"
                    disabled={active}
                    onPress={() =>
                      void manage(
                        stopped ? { action: "retry_failed", desktopRequestId: run.id } : { action: "update_all" },
                      )
                    }
                  />
                )
              }
            />
          )}
          {headline.progress !== undefined && (
            <ProgressBar done={BigInt(Math.round(headline.progress))} total={100n} label="Update progress" />
          )}
          <UpdateFeedback />
        </View>
        <AppUpdateStatus />
        {snapshot && <UpdateRows snapshot={snapshot} />}
      </SettingsGroup>
      {snapshot?.run && snapshot.run.state !== "dismissed" && <UpdateRun run={snapshot.run} />}
    </>
  );
}
