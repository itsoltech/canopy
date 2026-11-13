import { View } from "react-native";
import { Button } from "../../ui/Button";
import { UpdateRows } from "../updates/UpdateRows";
import { CliUpdates } from "../updates/CliUpdates";
import { UpdateFeedback, UpdateRun } from "../updates/UpdateSummary";
import { bulkUpdatesAvailable } from "../updates/model";
import { useUpdates } from "../updates/state";
import { SettingsGroup, SettingsActions, SettingChoice } from "./SettingsGroup";
import { confirmAction } from "./resource";

/** Settings and the sidebar sheet share action gates, progress and the durable update run. */
export function UpdateSettings() {
  const { snapshot, pending, manage } = useUpdates();
  const busy = !!pending || snapshot?.run?.state === "running";

  return (
    <SettingsGroup
      title="Updates"
      actions={
        <SettingsActions>
          {snapshot && (bulkUpdatesAvailable(snapshot) || snapshot.run?.state === "running") && (
            <Button
              title={snapshot.run?.state === "running" ? "Show update progress" : "Update all"}
              size="sm"
              disabled={!!pending}
              onPress={() => void manage({ action: "update_all" })}
            />
          )}
          <Button title="Check now" size="sm" disabled={busy} onPress={() => void manage({ action: "check" })} />
        </SettingsActions>
      }
    >
      <View style={{ gap: 8 }}>
        <UpdateFeedback />
        {snapshot && (
          <>
            <UpdateRun run={snapshot.run} />
            <UpdateRows snapshot={snapshot} pending={busy} manage={(request) => void manage(request)} />
            {!snapshot.gatewayBundled && (
              <SettingChoice
                title="Release channel"
                value={snapshot.channel}
                disabled={busy || !snapshot.admin}
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
            <CliUpdates snapshot={snapshot} disabled={busy} />
          </>
        )}
      </View>
    </SettingsGroup>
  );
}
