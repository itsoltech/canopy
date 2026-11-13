import type { MessageInitShape } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { cliUpdateActionable, appCheckPause, homeAppComputer } from "@canopy/domain/release/update-actions";
import { currentRemoteUpdate, newerAppVersion } from "@canopy/domain/release/remote-update-state";

export { bulkUpdatesAvailable } from "@canopy/domain/release/update-plan";

export type UpdateRequest = MessageInitShape<typeof ui.ManageUpdatesRequestSchema>;

export const updateBusy = (state = "") =>
  ["queued", "checking", "waiting_idle", "downloading", "restarting", "running"].includes(state);

export const updateLabel = (state = "") =>
  ({
    queued: "Queued",
    checking: "Checking…",
    waiting_idle: "Waiting for idle",
    downloading: "Downloading…",
    downloaded: "Ready",
    restarting: "Restarting…",
    failed: "Failed",
    blocked: "Blocked",
    rolled_back: "Rolled back",
    succeeded: "Updated",
    superseded: "Resolved",
    dismissed: "Dismissed",
    idle: "Up to date",
    paused: "Checks paused",
    running: "Updating…",
    managed_externally: "Managed externally",
    skipped: "Skipped",
    ahead: "Newer than gateway",
  })[state] ?? "Not checked";

export function updateHomes(snapshot: ui.UpdatesSnapshot) {
  return [
    { nodeId: "", name: "This computer", home: snapshot },
    ...snapshot.computers.flatMap((computer) =>
      computer.updates ? [{ nodeId: computer.nodeId, name: computer.name, home: computer.updates }] : [],
    ),
  ];
}

export function appPhase(app: ui.UpdatesSnapshot["app"]) {
  if (appCheckPause(app)) return "paused";

  return updateBusy(app?.phase) || app?.phase === "failed" ? app?.phase : app?.updaterPhase || app?.phase;
}

export function appTarget(app: ui.UpdatesSnapshot["app"]) {
  return (
    (updateBusy(app?.phase) || app?.phase === "failed" ? app?.targetVersion : "") ||
    app?.updaterVersion ||
    app?.availableVersion
  );
}

export function workerAction(
  worker: ui.WorkerUpdate,
  home: ui.UpdatesSnapshot,
  linked: boolean,
): UpdateRequest | undefined {
  if (updateBusy(worker.state) || updateBusy(worker.desktop?.phase) || !worker.connected) return;

  if (worker.desktop) {
    const app = worker.desktop;

    if (
      !linked &&
      app.connected &&
      !app.disabledReason &&
      (app.phase === "failed" || newerAppVersion(app.availableVersion, app.version))
    )
      return { action: "desktop", workerId: worker.workerId };
  } else if (
    worker.installKind === "binary" &&
    home.admin &&
    worker.version &&
    worker.version !== home.gatewayVersion &&
    worker.state !== "ahead"
  )
    return { action: "worker", workerId: worker.workerId };

  return undefined;
}

export function computerAction(computer: ui.ComputerUpdate): UpdateRequest | undefined {
  const reported = computer.updates?.app;
  const app = reported && currentRemoteUpdate(reported);

  if (
    !computer.remoteUpdate ||
    computer.presence !== "connected" ||
    !app?.connected ||
    app.disabledReason ||
    !!appCheckPause(app) ||
    updateBusy(app.phase) ||
    updateBusy(app.updaterPhase)
  )
    return;

  if (
    app.phase === "failed" ||
    app.ready ||
    app.updaterPhase === "downloaded" ||
    newerAppVersion(app.availableVersion, app.version)
  )
    return computer.nodeId ? { action: "computer", nodeId: computer.nodeId } : { action: "app" };

  return undefined;
}

export function updatesAvailable(snapshot: ui.UpdatesSnapshot, includeLinkedWorkers = true, includeHomeApp = true) {
  const homes = includeLinkedWorkers ? updateHomes(snapshot) : [{ home: snapshot, nodeId: "" }];
  const home = includeHomeApp ? homeAppComputer(snapshot) : undefined;

  return (
    (home && !!computerAction(home)) ||
    (!snapshot.gatewayBundled && snapshot.gatewayInstallKind === "binary" && snapshot.gatewayUpdateAvailable) ||
    snapshot.computers.some((computer) => !!computerAction(computer)) ||
    homes.some(
      ({ home, nodeId }) =>
        home.workers.some((worker) => !worker.bundled && workerAction(worker, home, !!nodeId)) ||
        home.cliWorkers.some((worker) => worker.cliTools.some(cliUpdateActionable)),
    )
  );
}

export function updatesRunning(snapshot: ui.UpdatesSnapshot) {
  return (
    snapshot.run?.state === "running" ||
    updateBusy(snapshot.gatewayState) ||
    updateHomes(snapshot).some(
      ({ home }) =>
        updateBusy(home.app?.phase) ||
        updateBusy(home.app?.updaterPhase) ||
        home.workers.some((worker) => updateBusy(worker.state) || updateBusy(worker.desktop?.phase)) ||
        home.cliWorkers.some((worker) => worker.cliTools.some((item) => item.tool?.install?.state === "running")),
    )
  );
}
