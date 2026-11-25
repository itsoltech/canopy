import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { updateCheckLabel } from "@canopy/domain/computer-presence";
import { computerUpdate } from "@canopy/domain/release/computer-update";
import { currentRemoteUpdate } from "@canopy/domain/release/remote-update-state";
import { gatewayUpdateLifecycle, updateInProgress, updateTargetKey } from "@canopy/domain/release/update-status";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import { presenceTime } from "../computers/presence";
import { computerAction } from "./model";
import { useUpdates } from "./state";
import { UpdateRow } from "./UpdateRow";

export function ComputerUpdateRow({ computer }: { computer: ui.ComputerUpdate }) {
  const { rowStatus, failedStep, active, pending, snapshot, manage } = useUpdates();
  const [now, setNow] = useState(Date.now);
  const restarting = ["updating", "restarting"].includes(computer.presence);
  const c = useColors();

  // An announced restart warns only when overdue.
  useEffect(() => {
    if (!restarting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);

    return () => clearInterval(timer);
  }, [restarting]);

  const local = !computer.nodeId;
  const name = local ? snapshot?.computerName || "Paired computer" : computer.name;
  const view = computerUpdate(computer, presenceTime, now);
  const reported = computer.updates?.app;
  const app = reported && currentRemoteUpdate(reported);
  const key = local ? updateTargetKey({ kind: "app" }) : updateTargetKey({ kind: "computer", nodeId: computer.nodeId });
  const status = rowStatus(key, view.status);
  const step = failedStep(key);
  const request = computerAction(computer);
  const failed = status === "failed";
  const inProgress = updateInProgress(status);

  const unavailable =
    !!pending || gatewayUpdateLifecycle(snapshot?.gatewayState) || computer.presence !== "connected" || !app?.connected;

  const detail =
    view.line || (computer.readState && computer.readState !== "fresh" ? computer.reason : "") || view.detail;

  const channel = app?.channel.replace(/^./, (letter) => letter.toUpperCase());

  return (
    <View style={{ paddingBottom: 8 }}>
      <UpdateRow
        name={name}
        version={app?.version || computer.version}
        target={view.target}
        status={status}
        error={
          failed
            ? (view.failed && view.detail) ||
              snapshot?.run?.steps[step]?.reason ||
              detail ||
              "The update did not finish."
            : undefined
        }
        busy={inProgress}
        progress={view.progress}
        action={
          request && !inProgress && step < 0
            ? {
                icon: failed ? "repeat" : local && status === "downloaded" ? "power" : "arrow-down-tray",
                label: failed
                  ? `Retry updating ${name}`
                  : local && status === "downloaded"
                    ? "Restart to update"
                    : `Update ${name}`,
                disabled: active || unavailable,
                run: () => void manage(request, key),
              }
            : undefined
        }
        errorActions={
          app?.phase === "failed" && (
            <Button
              title="Dismiss"
              size="sm"
              disabled={unavailable}
              onPress={() =>
                void manage({
                  action: local ? "app_dismiss" : "computer_dismiss",
                  nodeId: computer.nodeId,
                  desktopRequestId: app.requestId,
                })
              }
            />
          )
        }
      />
      {local && (
        <Text style={[styles.overlayMeta, { color: c.muted }]}>Includes this computer’s gateway and worker.</Text>
      )}
      {!failed && !!detail && (
        <Text style={[styles.overlayMeta, { color: view.overdue ? c.warning : c.muted }]}>{detail}</Text>
      )}
      <View style={[styles.row, { flexWrap: "wrap", columnGap: 8 }]}>
        {app && (
          <Text style={[styles.overlayMeta, { color: c.muted, flexShrink: 1 }]}>
            {[channel, updateCheckLabel(app.lastCheckedAtMs, presenceTime)].filter(Boolean).join(" · ")}
          </Text>
        )}
        {!local && computer.remoteUpdate && (
          <Button
            title="Check now"
            label={`Check ${name} for updates`}
            size="sm"
            variant="ghost"
            disabled={unavailable}
            onPress={() => void manage({ action: "computer_check", nodeId: computer.nodeId })}
          />
        )}
      </View>
    </View>
  );
}
