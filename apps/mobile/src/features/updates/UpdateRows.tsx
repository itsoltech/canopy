import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { homeAppComputer } from "@canopy/domain/release/update-actions";
import { isRateLimitMessage } from "@canopy/domain/release/http";
import { computerUpdate } from "@canopy/domain/release/computer-update";
import { currentRemoteUpdate } from "@canopy/domain/release/remote-update-state";
import {
  isUpdateStatus,
  updateInProgress,
  updateTargetKey,
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
    PHASE.get(snapshot.gatewayState) ??
    (paused
      ? "Checks paused"
      : snapshot.gatewayUpdateAvailable
        ? snapshot.gatewayInstallKind === "binary"
          ? "available"
          : "Managed externally"
        : snapshot.checkError || !snapshot.availableVersion
          ? "Not checked"
          : "current");

  const status = rowStatus(key, own);
  const step = failedStep(key);
  const binary = snapshot.gatewayInstallKind === "binary";
  const run = snapshot.run;

  return (
    <UpdateRow
      name="Gateway"
      version={snapshot.gatewayVersion}
      target={snapshot.availableVersion}
      status={status}
      line={paused ? snapshot.checkError : status === "waiting" ? WAITING : undefined}
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
        binary && status === "failed"
          ? {
              icon: "repeat",
              label: "Retry",
              disabled: active || !snapshot.admin,
              run: () =>
                step >= 0 && run
                  ? manage({ action: "retry_step", desktopRequestId: run.id, updateStepIndex: step }, key)
                  : manage({ action: "gateway" }, key),
            }
          : binary && snapshot.gatewayUpdateAvailable && !updateInProgress(status)
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
        const app = worker.desktop;
        const request = workerAction(worker, home, !!nodeId);

        const key = app
          ? updateTargetKey({ kind: "desktop", workerId: worker.workerId })
          : updateTargetKey({ kind: "worker", nodeId, workerId: worker.workerId });

        const current =
          worker.compatibility === "compatible" &&
          (app ? app.version === app.availableVersion : worker.version === home.gatewayVersion);

        const own = !worker.connected
          ? "Offline"
          : (PHASE.get(app?.phase || worker.state) ??
            (request
              ? "available"
              : worker.state === "managed_externally"
                ? "Managed externally"
                : worker.state === "ahead"
                  ? "Newer than gateway"
                  : current
                    ? "current"
                    : "Update required"));

        const status = rowStatus(key, own);
        const step = failedStep(key);
        const run = snapshot?.run;
        const reason = app?.disabledReason || app?.reason || worker.reason;

        return (
          <UpdateRow
            key={worker.workerId}
            name={worker.name}
            version={app?.version || worker.version}
            target={
              app?.targetVersion || app?.availableVersion || (worker.state === "ahead" ? "" : home.gatewayVersion)
            }
            status={status}
            line={status === "waiting" ? WAITING : isUpdateStatus(status) ? undefined : reason}
            error={status === "failed" ? reason || run?.steps[step]?.reason || "The update did not finish." : undefined}
            busy={updateInProgress(status)}
            progress={app?.phase === "downloading" ? app.progress : undefined}
            style={!worker.connected ? { opacity: 0.5 } : undefined}
            action={
              status === "failed" && (step >= 0 || request)
                ? {
                    icon: "repeat",
                    label: "Retry",
                    disabled: active || !worker.connected,
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
