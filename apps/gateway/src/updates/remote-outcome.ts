import type { ui } from "@canopy/contracts";
import { newerAppVersion, reachedUpdateVersion } from "@canopy/domain/release/remote-update-state";

/** Compare current target facts before consulting the historical failure of a request. */
function remoteStepApp(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot) {
  if (step.kind === "computer") return snapshot.computers.find((item) => item.nodeId === step.nodeId)?.updates?.app;

  if (step.kind === "desktop") return snapshot.workers.find((worker) => worker.workerId === step.workerId)?.desktop;

  return undefined;
}

export function remoteStepDismissed(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot): boolean {
  const app = remoteStepApp(step, snapshot);

  return !!step.requestId && app?.requestId === step.requestId && app.phase === "idle" && !app.reason;
}

export function remoteStepCurrent(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot): boolean {
  const app = remoteStepApp(step, snapshot);

  if (!app) return false;

  return (
    reachedUpdateVersion(app.version, step.version || app.targetVersion) ||
    (app.connected &&
      app.phase === "succeeded" &&
      !step.version &&
      ((!!step.requestId && app.requestId === step.requestId) || newerAppVersion(app.version, step.fromVersion))) ||
    (app.connected &&
      app.updaterCurrent &&
      (step.kind !== "computer" ||
        snapshot.computers.some((computer) => computer.nodeId === step.nodeId && computer.readState === "fresh")))
  );
}
