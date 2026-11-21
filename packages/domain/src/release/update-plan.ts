import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { newerAppVersion } from "./remote-update-state.ts";
import { knownUpdateOffline } from "./update-offline.ts";
import { binaryUpdateStatus, updateInProgress } from "./update-status.ts";

/** A downloaded package stays actionable when a feed check omits availableVersion. */
export function appUpdateTarget(app: ui.DesktopUpdateState | undefined): string {
  if (!app) return "";

  return (
    [app.updaterVersion, app.availableVersion, app.phase === "failed" ? app.targetVersion : ""].find((version) =>
      newerAppVersion(version, app.version),
    ) || ""
  );
}

/**
 * The version a desktop app's row shows as its target: only one newer than the running app. A finished request's
 * target_version is history; after the app updated past it another way, it would read as a downgrade.
 */
export function appRowTarget(app: ui.DesktopUpdateState | undefined): string {
  if (!app) return "";

  return appUpdateTarget(app) || (newerAppVersion(app.targetVersion, app.version) ? app.targetVersion : "");
}

export function appUpdateAvailable(app: ui.DesktopUpdateState | undefined): boolean {
  return !!app && (!!appUpdateTarget(app) || app.ready || app.updaterPhase === "downloaded");
}

function plannedStep(item: MessageInitShape<typeof ui.UpdateStepSchema>, snapshot: ui.UpdatesSnapshot): ui.UpdateStep {
  const step = create(ui.UpdateStepSchema, { state: "queued", ...item });
  const offline = step.state === "queued" && knownUpdateOffline(step, snapshot);

  if (offline) {
    step.state = "skipped";
    step.reason = offline;
  }

  return step;
}

/** Shared eligibility for every Update all control and the owner gateway's durable plan. */
export function bulkUpdateSteps(snapshot: ui.UpdatesSnapshot): ui.UpdateStep[] {
  const phase = binaryUpdateStatus(snapshot.gatewayState);

  if (snapshot.gatewayInstallKind === "binary" && phase && updateInProgress(phase)) return [];
  const steps: ui.UpdateStep[] = [];
  const add = (item: MessageInitShape<typeof ui.UpdateStepSchema>) => steps.push(plannedStep(item, snapshot));

  const homes = [
    { home: snapshot, nodeId: "", name: "" },
    ...snapshot.computers.flatMap((computer) =>
      computer.remoteUpdate && computer.updates
        ? [{ home: computer.updates, nodeId: computer.nodeId, name: computer.name }]
        : [],
    ),
  ];

  if (!snapshot.gatewayBundled && newerAppVersion(snapshot.availableVersion, snapshot.gatewayVersion))
    add({
      kind: "gateway",
      label: "Gateway",
      version: snapshot.availableVersion,
      fromVersion: snapshot.gatewayVersion,
      ...(snapshot.gatewayInstallKind !== "binary" && {
        state: "skipped",
        reason: snapshot.gatewayReason || "Update the gateway with its installer.",
      }),
    });
  const gateway = steps.find((step) => step.kind === "gateway" && step.state === "queued");

  for (const { home, nodeId, name } of homes) {
    const target = nodeId ? home.gatewayVersion : gateway?.version || home.gatewayVersion;

    for (const worker of home.workers) {
      if (worker.bundled || worker.installKind === "desktop" || !newerAppVersion(target, worker.version)) continue;
      add({
        kind: "worker",
        workerId: worker.workerId,
        nodeId,
        label: name ? `${name} · ${worker.name}` : worker.name,
        version: target,
        fromVersion: worker.version,
        ...(worker.installKind !== "binary" && {
          state: "skipped",
          reason: worker.reason || "Update this worker with its installer.",
        }),
      });
    }
  }

  for (const worker of snapshot.workers) {
    if (worker.bundled || worker.installKind !== "desktop" || !appUpdateAvailable(worker.desktop)) continue;
    add({
      kind: "desktop",
      workerId: worker.workerId,
      label: `${worker.name} · Canopy app`,
      version: appUpdateTarget(worker.desktop),
      fromVersion: worker.desktop?.version || "",
      ...(worker.desktop?.disabledReason && { state: "skipped", reason: worker.desktop.disabledReason }),
    });
  }

  // Keep our gateway alive until every linked computer returns from its restart.
  for (const computer of snapshot.computers) {
    const app = computer.updates?.app;

    if (!appUpdateAvailable(app)) continue;
    add({
      kind: "computer",
      nodeId: computer.nodeId,
      label: `${computer.name} · Canopy app`,
      version: appUpdateTarget(app),
      fromVersion: app?.version || computer.version,
      ...((!computer.remoteUpdate || (app?.connected && app.disabledReason)) && {
        state: "skipped",
        reason: app?.disabledReason || computer.reason || "Update Canopy on that computer.",
      }),
    });
  }

  if (snapshot.gatewayBundled && appUpdateAvailable(snapshot.app))
    add({
      kind: "app",
      label: `${snapshot.computerName || "This computer"} · Canopy app`,
      version: appUpdateTarget(snapshot.app),
      fromVersion: snapshot.app?.version || "",
      ...((!snapshot.appUpdateSupported || (snapshot.app?.connected && snapshot.app.disabledReason)) && {
        state: "skipped",
        reason: snapshot.app?.disabledReason || "Update this computer from its own window.",
      }),
    });

  return steps.filter(
    (step, index) =>
      steps.findIndex(
        (other) => other.kind === step.kind && other.nodeId === step.nodeId && other.workerId === step.workerId,
      ) === index,
  );
}

/**
 * The run Update all writes. The gateway persists it; clients show the same steps as "Queued" the moment the user
 * confirms, before the gateway answers.
 */
export const plannedUpdateRun = (snapshot: ui.UpdatesSnapshot, id: string): ui.UpdateRun =>
  create(ui.UpdateRunSchema, { id, state: "running", steps: bulkUpdateSteps(snapshot) });

export const bulkUpdatesAvailable = (snapshot: ui.UpdatesSnapshot): boolean =>
  bulkUpdateSteps(snapshot).some((step) => step.state === "queued");

/** Newer releases for this gateway or its workers that need an external installer. */
export function externalUpdatesAvailable(snapshot: ui.UpdatesSnapshot): boolean {
  return (
    (!snapshot.gatewayBundled && snapshot.gatewayInstallKind !== "binary" && snapshot.gatewayUpdateAvailable) ||
    snapshot.workers.some(
      (worker) =>
        !worker.bundled &&
        worker.installKind !== "binary" &&
        worker.installKind !== "desktop" &&
        newerAppVersion(snapshot.gatewayVersion, worker.version),
    )
  );
}

/** Canopy's part of a result saved or returned by a gateway that also planned CLI installs. */
export function canopyUpdateRun(run: ui.UpdateRun | undefined): ui.UpdateRun | undefined {
  if (!run?.steps.length) return undefined;
  const steps = run.steps.filter((step) => step.kind !== "cli");

  if (steps.length === run.steps.length) return run;

  if (!steps.length) return undefined;
  let state = run.state;
  let reason = "";

  if (!["dismissed", "superseded"].includes(state)) {
    const pending = steps.some((step) => ["queued", "running"].includes(step.state));
    const failed = steps.find((step) => ["failed", "blocked"].includes(step.state));

    if (state === "running" && pending) {
      if (failed) reason = "Some updates failed. Other updates continue.";
    } else if (failed) {
      state = failed.state;
      reason = failed.reason;
    } else {
      state = pending || steps.some((step) => step.state === "dismissed") ? "superseded" : "succeeded";
    }
  }

  return create(ui.UpdateRunSchema, { ...run, steps, state, reason });
}
