import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { homeAppComputer } from "@canopy/domain/release/update-actions";
import { isRateLimitMessage } from "@canopy/domain/release/http";
import { computerUpdate } from "@canopy/domain/release/computer-update";
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
import { presenceTime } from "../computers/presence";
import { styles, useColors } from "../../ui/theme";
import { Button } from "../../ui/Button";
import { UpdateRow } from "./UpdateRow";
import { computerAction, updateHomes, workerAction, type UpdateRequest } from "./model";
import { useUpdates } from "./state";

type Manage = (request: UpdateRequest, target?: string) => void;

type Props = { snapshot: ui.UpdatesSnapshot; pending: boolean; manage: Manage };

const PHASE = new Map<string, UpdateStatus>([
  ["queued", "queued"],
  ["waiting_idle", "waiting"],
  ["downloading", "updating"],
  ["restarting", "restarting"],
  ["failed", "failed"],
]);

const WAITING = "Restarts after its current turns end.";

/** Web: UpdateRows. This computer, linked computers, then workers grouped by computer. */
export function UpdateRows({ snapshot, pending, manage }: Props) {
  const home = homeAppComputer(snapshot);

  return (
    <View>
      {home ? <ComputerRow computer={home} pending={pending} manage={manage} /> : <GatewayRow snapshot={snapshot} />}
      {snapshot.computers.map((computer) => (
        <ComputerRow key={computer.nodeId} computer={computer} pending={pending} manage={manage} />
      ))}
      {updateHomes(snapshot).map(({ nodeId, name, home }) => (
        <WorkerRows key={nodeId} home={home} name={name} nodeId={nodeId} pending={pending} manage={manage} />
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
          ? snapshot.departure?.reason ||
            snapshot.gatewayReason ||
            run?.steps[step]?.reason ||
            "The gateway update failed."
          : undefined
      }
      busy={updateInProgress(status)}
      action={
        binary && status === "failed" && (step >= 0 || snapshot.gatewayUpdateAvailable)
          ? {
              icon: "repeat",
              label: "Retry",
              disabled: active || !snapshot.admin,
              run: () =>
                step >= 0 && run
                  ? manage({ action: "retry_step", desktopRequestId: run.id, updateStepIndex: step }, key)
                  : manage({ action: "gateway" }, key),
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

function ComputerRow({ computer, pending, manage }: { computer: ui.ComputerUpdate; pending: boolean; manage: Manage }) {
  const { rowStatus, failedStep, active, snapshot } = useUpdates();
  const [now, setNow] = useState(Date.now);
  const restarting = ["updating", "restarting"].includes(computer.presence);

  // An announced restart warns only when overdue: the row rechecks the time while it lasts.
  useEffect(() => {
    if (!restarting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);

    return () => clearInterval(timer);
  }, [restarting]);

  const local = !computer.nodeId;
  const view = computerUpdate(computer, presenceTime, now);
  const reported = computer.updates?.app;
  const app = reported && currentRemoteUpdate(reported);
  const key = local ? updateTargetKey({ kind: "app" }) : updateTargetKey({ kind: "computer", nodeId: computer.nodeId });
  const status = rowStatus(key, view.status);
  const step = failedStep(key);
  const run = snapshot?.run;
  const request = computerAction(computer);
  const failed = status === "failed";
  const inProgress = updateInProgress(status);

  // Phones have no tooltips: a late peer read or an edge state's reason takes the second line.
  const line =
    view.line ||
    (computer.reason && computer.readState && computer.readState !== "fresh" ? computer.reason : "") ||
    (isUpdateStatus(status) ? "" : view.detail);

  return (
    <UpdateRow
      name={local ? "This computer" : computer.name}
      version={app?.version || computer.version}
      target={view.target}
      status={status}
      line={line}
      lineTone={view.overdue ? "amber" : undefined}
      error={failed ? view.detail || run?.steps[step]?.reason || "The update did not finish." : undefined}
      busy={inProgress}
      progress={view.progress}
      action={
        failed && (step >= 0 || app?.phase === "failed")
          ? {
              icon: "repeat",
              label: "Retry",
              disabled: active || computer.presence !== "connected",
              run: () =>
                step >= 0 && run
                  ? manage({ action: "retry_step", desktopRequestId: run.id, updateStepIndex: step }, key)
                  : manage(local ? { action: "app" } : { action: "computer", nodeId: computer.nodeId }, key),
            }
          : request && !inProgress
            ? {
                icon: local && status === "downloaded" ? "power" : "arrow-down-tray",
                label: local && status === "downloaded" ? "Restart to update" : `Update ${computer.name}`,
                disabled: active || pending,
                run: () => manage(request, key),
              }
            : undefined
      }
      errorActions={
        app?.phase === "failed" && (
          <Button
            title="Dismiss"
            size="sm"
            disabled={pending}
            onPress={() =>
              manage({
                action: local ? "app_dismiss" : "computer_dismiss",
                nodeId: computer.nodeId,
                desktopRequestId: app.requestId,
              })
            }
          />
        )
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

function WorkerRows({
  home,
  name,
  nodeId,
  pending,
  manage,
}: {
  home: ui.UpdatesSnapshot;
  name: string;
  nodeId: string;
  pending: boolean;
  manage: Manage;
}) {
  const c = useColors();
  const { rowStatus, failedStep, active, snapshot } = useUpdates();
  const workers = home.workers.filter((worker) => !worker.bundled);

  if (!workers.length) return null;

  return (
    <View style={{ borderTopWidth: 1, borderColor: c.line, paddingTop: 8 }}>
      <Text numberOfLines={1} accessibilityRole="header" style={[styles.overlayHeading, { color: c.muted }]}>
        {nodeId ? `Workers · ${name}` : "Workers"}
      </Text>
      {workers.map((worker) => {
        const app = worker.desktop && currentRemoteUpdate(worker.desktop);
        const connected = app?.connected ?? worker.connected;
        const request = workerAction(worker, home, !!nodeId);

        const key = app
          ? updateTargetKey({ kind: "desktop", workerId: worker.workerId })
          : updateTargetKey({ kind: "worker", nodeId, workerId: worker.workerId });

        const status = rowStatus(key, workerStatus(worker, app, home.gatewayVersion, request));
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
            error={status === "failed" ? reason || run?.steps[step]?.reason || "The update did not finish." : undefined}
            busy={updateInProgress(status)}
            progress={app?.phase === "downloading" ? app.progress : undefined}
            style={!connected && !updateInProgress(status) ? { opacity: 0.5 } : undefined}
            action={
              status === "failed" && (step >= 0 || request)
                ? {
                    icon: "repeat",
                    label: "Retry",
                    disabled: active || !connected || !!app?.disabledReason,
                    run: () => {
                      if (step >= 0 && run)
                        manage({ action: "retry_step", desktopRequestId: run.id, updateStepIndex: step }, key);
                      else if (request) manage(request, key);
                    },
                  }
                : request && !updateInProgress(status)
                  ? {
                      icon: "arrow-down-tray",
                      label: `Update ${worker.name}`,
                      disabled: active || pending,
                      run: () => manage(request, key),
                    }
                  : undefined
            }
            errorActions={
              app?.phase === "failed" &&
              !nodeId && (
                <Button
                  title="Dismiss"
                  size="sm"
                  disabled={pending}
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
