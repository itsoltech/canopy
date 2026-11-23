import { Text } from "react-native";
import type { ui } from "@canopy/contracts";
import { updateCheckLabel } from "@canopy/domain/computer-presence";
import { computerUpdate } from "@canopy/domain/release/computer-update";
import { currentRemoteUpdate } from "@canopy/domain/release/remote-update-state";
import { gatewayUpdateLifecycle, updateTargetKey } from "@canopy/domain/release/update-status";
import { Button } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { computerAction } from "../updates/model";
import { useUpdates } from "../updates/state";
import { UpdateBadge } from "../updates/UpdateRow";
import { UpdateFeedback } from "../updates/UpdateSummary";
import { WhatsNewSettings } from "../updates/WhatsNew";
import { AppUpdateStatus } from "./AppUpdateStatus";
import { SettingsActions, SettingsGroup, SettingsRow } from "./SettingsGroup";

export function AppUpdatesSettings() {
  const { snapshot } = useUpdates();

  return (
    <>
      <AppUpdateStatus title="App updates" />
      <WhatsNewSettings />
      <UpdateFeedback />
      {!!snapshot?.computers.length && (
        <SettingsGroup
          title="Linked computers"
          description="Each computer keeps its own channel and check frequency. Change them on that computer."
        >
          {snapshot.computers.map((computer) => (
            <LinkedAppUpdate key={computer.nodeId} computer={computer} />
          ))}
        </SettingsGroup>
      )}
    </>
  );
}

function LinkedAppUpdate({ computer }: { computer: ui.ComputerUpdate }) {
  const { active, pending, manage, rowStatus, snapshot } = useUpdates();
  const c = useColors();
  const view = computerUpdate(computer);
  const app = computer.updates?.app && currentRemoteUpdate(computer.updates.app);
  const version = app?.version || computer.version || "Version unknown";
  const channel = app?.channel.replace(/^./, (letter) => letter.toUpperCase());
  const versions = [version, view.target !== version && view.target].filter(Boolean).join(" → ");
  const request = computerAction(computer);
  const key = updateTargetKey({ kind: "computer", nodeId: computer.nodeId });

  const disabled =
    !!pending || gatewayUpdateLifecycle(snapshot?.gatewayState) || computer.presence !== "connected" || !app?.connected;

  const detail = computer.remoteUpdate || computer.presence !== "connected" ? view.line || view.detail : "";

  return (
    <SettingsRow title={computer.name} description={[versions, channel].filter(Boolean).join(" · ")}>
      <UpdateBadge status={rowStatus(key, view.status)} />
      <Text style={[styles.workMeta, { color: c.muted }]}>{updateCheckLabel(app?.lastCheckedAtMs)}</Text>
      {!!detail && <Text style={[styles.workMeta, { color: view.failed ? c.danger : c.muted }]}>{detail}</Text>}
      {computer.remoteUpdate ? (
        <SettingsActions>
          {app?.phase === "failed" && (
            <Button
              title="Dismiss"
              size="sm"
              disabled={disabled}
              onPress={() =>
                void manage({ action: "computer_dismiss", nodeId: computer.nodeId, desktopRequestId: app.requestId })
              }
            />
          )}
          <Button
            title="Check now"
            size="sm"
            disabled={disabled}
            onPress={() => void manage({ action: "computer_check", nodeId: computer.nodeId })}
          />
          <Button
            title={app?.phase === "failed" ? "Request again" : "Update"}
            size="sm"
            variant={request ? "primary" : "secondary"}
            disabled={disabled || active || !request}
            onPress={() => request && void manage(request, key)}
          />
        </SettingsActions>
      ) : (
        <Text style={[styles.workMeta, { color: c.muted }]}>Update on that computer</Text>
      )}
    </SettingsRow>
  );
}
