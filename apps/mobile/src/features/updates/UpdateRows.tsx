import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { presenceLabel } from "@canopy/domain/computer-presence";
import { appCheckPause, homeAppComputer } from "@canopy/domain/release/update-actions";
import { isRateLimitMessage } from "@canopy/domain/release/http";
import { presenceTime } from "../computers/presence";
import { styles, useColors } from "../../ui/theme";
import { UpdateRow } from "./UpdateRow";
import { Button } from "../../ui/Button";
import { currentRemoteUpdate, reachedUpdateVersion } from "@canopy/domain/release/remote-update-state";
import {
  appPhase,
  appTarget,
  computerAction,
  updateBusy,
  updateHomes,
  updateLabel,
  workerAction,
  type UpdateRequest,
} from "./model";

type Props = { snapshot: ui.UpdatesSnapshot; pending: boolean; manage: (request: UpdateRequest) => void };

export function UpdateRows({ snapshot, pending, manage }: Props) {
  const gatewayBusy = updateBusy(snapshot.gatewayState);

  const failed =
    snapshot.gatewayState === "failed" || ["failed", "rolled_back"].includes(snapshot.departure?.state ?? "");

  const home = homeAppComputer(snapshot);

  return (
    <View>
      {home ? (
        <ComputerRow computer={home} pending={pending} manage={manage} />
      ) : (
        <UpdateRow
          name="Gateway"
          version={snapshot.gatewayVersion}
          target={snapshot.availableVersion}
          status={
            failed
              ? "Failed"
              : gatewayBusy
                ? updateLabel(snapshot.gatewayState)
                : isRateLimitMessage(snapshot.checkError)
                  ? "Checks paused"
                  : snapshot.gatewayUpdateAvailable
                    ? "Available"
                    : snapshot.checkError || !snapshot.availableVersion
                      ? "Not checked"
                      : "Up to date"
          }
          failed={failed}
          busy={gatewayBusy}
          reason={
            !failed && isRateLimitMessage(snapshot.checkError)
              ? snapshot.checkError
              : snapshot.departure?.reason || snapshot.gatewayReason || snapshot.checkError
          }
          action={
            snapshot.gatewayInstallKind === "binary" && !gatewayBusy && (snapshot.gatewayUpdateAvailable || failed)
              ? {
                  label: failed ? "Retry gateway update" : "Update gateway",
                  disabled: pending || !snapshot.admin,
                  run: () => manage({ action: "gateway" }),
                }
              : undefined
          }
        />
      )}
      {snapshot.computers.map((computer) => (
        <ComputerRow key={computer.nodeId} computer={computer} pending={pending} manage={manage} />
      ))}
      {updateHomes(snapshot).map(({ nodeId, name, home }) => (
        <WorkerRows key={nodeId} home={home} name={name} linked={!!nodeId} pending={pending} manage={manage} />
      ))}
    </View>
  );
}

function ComputerRow({
  computer,
  pending,
  manage,
}: {
  computer: ui.ComputerUpdate;
  pending: boolean;
  manage: Props["manage"];
}) {
  const reported = computer.updates?.app;
  const app = reported && currentRemoteUpdate(reported);
  const request = computerAction(computer);
  const away = computer.presence !== "connected";

  const busy =
    ["updating", "restarting"].includes(computer.presence) || updateBusy(app?.phase) || updateBusy(app?.updaterPhase);

  const departure = computer.updates?.departure;

  const failed =
    (!appCheckPause(app) && (app?.phase === "failed" || app?.updaterPhase === "error")) ||
    (["failed", "rolled_back"].includes(departure?.state ?? "") &&
      !reachedUpdateVersion(app?.version || computer.version, departure?.targetVersion || "") &&
      !busy &&
      !(app?.phase === "succeeded" && app.targetVersion === departure?.targetVersion));

  const target = appTarget(app);

  return (
    <UpdateRow
      name={computer.name}
      version={app?.version || computer.version}
      target={target}
      checkedAt={app?.lastCheckedAtMs ?? 0}
      status={
        away
          ? presenceLabel(computer.presence, computer.presenceSinceMs, presenceTime)
          : !computer.remoteUpdate
            ? "Manual update"
            : !app?.connected || app.disabledReason
              ? "Unavailable"
              : failed
                ? departure?.state === "rolled_back"
                  ? "Rolled back"
                  : "Failed"
                : busy
                  ? updateLabel(appPhase(app))
                  : app?.ready
                    ? "Ready"
                    : appCheckPause(app)
                      ? "Checks paused"
                      : request
                        ? "Available"
                        : computer.remoteUpdate
                          ? "Up to date"
                          : "Manual update"
      }
      busy={busy}
      failed={failed}
      notice={!computer.remoteUpdate ? computer.reason : undefined}
      reason={
        !computer.remoteUpdate
          ? undefined
          : computer.reason ||
            app?.disabledReason ||
            (!failed && appCheckPause(app)) ||
            (failed ? departure?.reason : "") ||
            app?.reason ||
            app?.updaterError
      }
      progress={
        app?.phase === "downloading"
          ? app.progress
          : app?.updaterPhase === "downloading"
            ? app.updaterProgress
            : undefined
      }
      action={
        request
          ? {
              label:
                app?.phase === "failed"
                  ? `Request update again on ${computer.name}`
                  : `Update Canopy on ${computer.name}`,
              disabled: pending,
              run: () => manage(request),
            }
          : undefined
      }
    >
      {app?.phase === "failed" && (
        <Button
          title="Dismiss"
          size="sm"
          disabled={pending}
          onPress={() =>
            manage({
              action: computer.nodeId ? "computer_dismiss" : "app_dismiss",
              nodeId: computer.nodeId,
              desktopRequestId: app.requestId,
            })
          }
        />
      )}
    </UpdateRow>
  );
}

function WorkerRows({
  home,
  name,
  linked,
  pending,
  manage,
}: {
  home: ui.UpdatesSnapshot;
  name: string;
  linked: boolean;
  pending: boolean;
  manage: Props["manage"];
}) {
  const c = useColors();
  const workers = home.workers.filter((worker) => !worker.bundled);

  if (!workers.length) return null;

  return (
    <View style={{ borderTopWidth: 1, borderColor: c.line, paddingTop: 8 }}>
      <Text numberOfLines={1} accessibilityRole="header" style={[styles.overlayHeading, { color: c.muted }]}>
        {linked ? `Workers · ${name}` : "Workers"}
      </Text>
      {workers.map((worker) => {
        const app = worker.desktop;
        const request = workerAction(worker, home, linked);
        const busy = updateBusy(worker.state) || updateBusy(app?.phase);
        const failed = worker.state === "failed" || app?.phase === "failed";

        return (
          <UpdateRow
            key={worker.workerId}
            name={worker.name}
            version={app?.version || worker.version}
            target={
              app?.targetVersion || app?.availableVersion || (worker.state === "ahead" ? "" : home.gatewayVersion)
            }
            checkedAt={app ? app.lastCheckedAtMs : undefined}
            status={
              !worker.connected
                ? "Offline"
                : failed
                  ? "Failed"
                  : busy
                    ? updateLabel(app?.phase || worker.state)
                    : request
                      ? "Available"
                      : worker.state === "managed_externally"
                        ? "Managed externally"
                        : worker.compatibility !== "compatible" ||
                            (worker.version !== home.gatewayVersion && worker.state !== "ahead")
                          ? "Update required"
                          : updateLabel(worker.state)
            }
            busy={busy}
            failed={failed}
            reason={app?.disabledReason || app?.reason || worker.reason}
            progress={app?.phase === "downloading" ? app.progress : undefined}
            action={
              request ? { label: `Update ${worker.name}`, disabled: pending, run: () => manage(request) } : undefined
            }
          >
            {app?.phase === "failed" && !linked && (
              <Button
                title="Dismiss"
                size="sm"
                disabled={pending}
                onPress={() =>
                  manage({ action: "desktop_dismiss", workerId: worker.workerId, desktopRequestId: app.requestId })
                }
              />
            )}
          </UpdateRow>
        );
      })}
    </View>
  );
}
