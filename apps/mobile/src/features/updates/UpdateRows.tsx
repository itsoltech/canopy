import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { homeAppComputer } from "@canopy/domain/release/update-actions";
import { isRateLimitMessage } from "@canopy/domain/release/http";
import { currentRemoteUpdate, newerAppVersion } from "@canopy/domain/release/remote-update-state";
import { appRowTarget, appUpdateAvailable } from "@canopy/domain/release/update-plan";
import {
  binaryUpdateDetail,
  binaryUpdateStatus,
  gatewayRowTarget,
  isUpdateStatus,
  updateInProgress,
  updateTargetKey,
  workerUpdateTarget,
  type UpdateStatus,
} from "@canopy/domain/release/update-status";
import { ComputerUpdateRow } from "./ComputerUpdateRow";
import { styles, useColors } from "../../ui/theme";
import { Button } from "../../ui/Button";
import { SettingsGroupHeader } from "../settings/SettingsGroup";
import { UpdateRow } from "./UpdateRow";
import { updateHomes, workerAction, type UpdateRequest } from "./model";
import { useUpdates } from "./state";

const PHASE = new Map<string, UpdateStatus>([
  ["queued", "queued"],
  ["waiting_idle", "waiting"],
  ["downloading", "updating"],
  ["restarting", "restarting"],
  ["failed", "failed"],
]);

const WAITING = "Restarts after its current turns end.";

/** Each installation has one row. A bundled gateway and worker update with their desktop app. */
export function UpdateRows({ snapshot }: { snapshot: ui.UpdatesSnapshot }) {
  const home = homeAppComputer(snapshot);

  return (
    <View>
      {home ? <ComputerUpdateRow computer={home} /> : <GatewayRow snapshot={snapshot} />}
      {!!snapshot.computers.length && (
        <SettingsGroupHeader
          title="Linked computers"
          description="Change each computer’s release channel and check frequency on that computer."
        />
      )}
      {snapshot.computers.map((computer) => (
        <ComputerUpdateRow key={computer.nodeId} computer={computer} />
      ))}
      {updateHomes(snapshot).map(({ nodeId, name, home }) => (
        <WorkerRows key={nodeId} home={home} name={name} nodeId={nodeId} />
      ))}
    </View>
  );
}

function GatewayRow({ snapshot }: { snapshot: ui.UpdatesSnapshot }) {
  const { rowStatus, failedStep, active, manage } = useUpdates();
  const key = updateTargetKey({ kind: "gateway" });
  const paused = isRateLimitMessage(snapshot.checkError);

  const own =
    binaryUpdateStatus(snapshot.gatewayState) ??
    (paused
      ? "Checks paused"
      : snapshot.gatewayUpdateAvailable
        ? snapshot.gatewayInstallKind === "binary"
          ? "available"
          : "Manual update"
        : snapshot.checkError || !snapshot.availableVersion
          ? "Not checked"
          : "current");

  const status = rowStatus(key, own);
  const step = failedStep(key);
  const binary = snapshot.gatewayInstallKind === "binary";
  const run = snapshot.run;
  const target = gatewayRowTarget(snapshot);

  return (
    <UpdateRow
      name="Gateway"
      version={snapshot.gatewayVersion}
      target={target}
      status={status}
      line={
        status === "Checks paused"
          ? snapshot.checkError
          : status === "Manual update"
            ? snapshot.gatewayReason.replace(/^Managed externally\.\s*/, "")
            : binaryUpdateDetail(snapshot.gatewayState)
      }
      error={
        status === "failed"
          ? run?.steps[step]?.reason ||
            snapshot.departure?.reason ||
            snapshot.gatewayReason ||
            "The gateway update failed."
          : status === "Not checked"
            ? snapshot.checkError || undefined
            : undefined
      }
      busy={updateInProgress(status)}
      progress={status === "downloading" ? snapshot.gatewayDownloadProgress : undefined}
      action={
        binary && status === "failed" && step < 0 && snapshot.gatewayUpdateAvailable
          ? {
              icon: "repeat",
              label: "Retry",
              disabled: active || !snapshot.admin,
              run: () => void manage({ action: "gateway" }, key),
            }
          : binary && status === "available"
            ? {
                icon: "arrow-down-tray",
                label: "Update gateway",
                disabled: active || !snapshot.admin,
                run: () => manage({ action: "gateway" }, key),
              }
            : undefined
      }
    />
  );
}

function workerStatus(
  worker: ui.WorkerUpdate,
  app: ui.DesktopUpdateState | undefined,
  gatewayVersion: string,
  request: UpdateRequest | undefined,
): UpdateStatus | string {
  if (app) {
    if (app.disabledReason) return "Unavailable";

    if (!app.connected) return "Offline";
    const phase = PHASE.get(app.phase);

    if (phase) return phase;

    if (app.ready || app.updaterPhase === "downloaded") return "downloaded";

    if (appUpdateAvailable(app)) return "available";

    return app.updaterCurrent || app.availableVersion ? "current" : "Not checked";
  }

  if (!worker.connected && worker.state !== "restarting" && worker.state !== "reconnecting") return "Offline";

  if (worker.installKind === "desktop") return "Unavailable";
  const phase = binaryUpdateStatus(worker.state);

  if (phase) return phase;

  if (worker.state === "ahead") return "Newer than gateway";

  if (worker.version === gatewayVersion && worker.compatibility === "compatible") return "current";

  if (request) return "available";

  return worker.installKind !== "binary" && newerAppVersion(gatewayVersion, worker.version)
    ? "Manual update"
    : "Update required";
}

function WorkerRows({ home, name, nodeId }: { home: ui.UpdatesSnapshot; name: string; nodeId: string }) {
  const c = useColors();
  const { rowStatus, failedStep, active, snapshot, manage } = useUpdates();

  const homeOnline =
    !nodeId || snapshot?.computers.some((computer) => computer.nodeId === nodeId && computer.presence === "connected");

  const workers = home.workers.filter((worker) => !worker.bundled);

  if (!workers.length) return null;

  return (
    <View style={{ borderTopWidth: 1, borderColor: c.line, paddingTop: 8 }}>
      <Text numberOfLines={1} accessibilityRole="header" style={[styles.overlayHeading, { color: c.muted }]}>
        {nodeId ? `Workers · ${name}` : "Workers"}
      </Text>
      {workers.map((worker) => {
        const app = worker.desktop && currentRemoteUpdate(worker.desktop);
        const connected = homeOnline && (app?.connected ?? worker.connected);
        const request = workerAction(worker, home, !!nodeId);

        const key = app
          ? updateTargetKey({ kind: "desktop", workerId: worker.workerId })
          : updateTargetKey({ kind: "worker", nodeId, workerId: worker.workerId });

        const status = homeOnline ? rowStatus(key, workerStatus(worker, app, home.gatewayVersion, request)) : "Offline";
        const step = failedStep(key);
        const run = snapshot?.run;
        const reason = app ? app.disabledReason || app.reason : worker.reason.replace(/^Managed externally\.\s*/, "");

        return (
          <UpdateRow
            key={worker.workerId}
            name={worker.name}
            version={app?.version || worker.version}
            target={app ? appRowTarget(app) : workerUpdateTarget(worker, home.gatewayVersion)}
            status={status}
            line={
              isUpdateStatus(status)
                ? app
                  ? status === "waiting"
                    ? WAITING
                    : undefined
                  : status === "queued" || updateInProgress(status)
                    ? binaryUpdateDetail(worker.state)
                    : undefined
                : reason
            }
            error={status === "failed" ? run?.steps[step]?.reason || reason || "The update did not finish." : undefined}
            busy={updateInProgress(status)}
            progress={app ? (app.phase === "downloading" ? app.progress : undefined) : worker.downloadProgress}
            style={!connected && !updateInProgress(status) ? { opacity: 0.5 } : undefined}
            action={
              request && step < 0 && !updateInProgress(status)
                ? {
                    icon: status === "failed" ? "repeat" : "arrow-down-tray",
                    label: status === "failed" ? `Retry updating ${worker.name}` : `Update ${worker.name}`,
                    disabled: active || !connected,
                    run: () => void manage(request, key),
                  }
                : undefined
            }
            errorActions={
              app?.phase === "failed" &&
              !nodeId && (
                <Button
                  title="Dismiss"
                  size="sm"
                  disabled={active}
                  onPress={() =>
                    manage({ action: "desktop_dismiss", workerId: worker.workerId, desktopRequestId: app.requestId })
                  }
                />
              )
            }
          />
        );
      })}
    </View>
  );
}
