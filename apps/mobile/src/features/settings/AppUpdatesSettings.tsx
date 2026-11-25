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
import { AppUpdateStatus } from "./AppUpdateStatus";
import { confirmAction } from "./resource";
import { SettingsActions, SettingsGroup, SettingChoice } from "./SettingsGroup";

export function AppUpdatesSettings() {
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
          <SettingsActions>
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
            {stopped ? (
              <Button
                title="Retry failed"
                size="sm"
                variant="primary"
                disabled={active}
                onPress={() => void manage({ action: "retry_failed", desktopRequestId: run.id })}
              />
            ) : (
              snapshot &&
              bulkUpdatesAvailable(snapshot) && (
                <Button
                  title="Update all"
                  size="sm"
                  variant="primary"
                  disabled={active}
                  onPress={() => void manage({ action: "update_all" })}
                />
              )
            )}
          </SettingsActions>
        }
      >
        <View style={{ gap: 6 }}>
          {!!headline.text && (
            <Text
              accessibilityLiveRegion="polite"
              style={[
                styles.workMeta,
                { color: headline.tone === "rose" ? c.danger : headline.tone === "ink" ? c.text : c.muted },
              ]}
            >
              {headline.text}
            </Text>
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
      {snapshot && !snapshot.gatewayBundled && (
        <SettingsGroup title="Update preferences">
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
        </SettingsGroup>
      )}
    </>
  );
}
