import type { ui } from "@canopy/contracts";
import type { DesktopUpdateStatus } from "@canopy/ui/desktop";
import { cliUpdateActionable } from "@canopy/domain/release/update-actions";
import { updateBusy } from "./updates.svelte.ts";
import { computerUpdatesAvailable } from "./computer-updates.ts";

export function workerCurrent(worker: ui.WorkerUpdate, gatewayVersion: string): boolean {
  if (worker.state === "failed" || updateBusy(worker.state) || worker.compatibility !== "compatible") return false;

  if (worker.desktop) {
    const app = worker.desktop;

    return (
      app.connected &&
      !app.disabledReason &&
      ["idle", "succeeded"].includes(app.phase) &&
      !!app.version &&
      app.availableVersion === app.version
    );
  }

  return worker.connected && !!worker.version && worker.version === gatewayVersion;
}

export const cliCurrent = (item: ui.WorkerCliTool): boolean =>
  !!item.tool?.version &&
  !!item.latest?.version &&
  item.tool.version === item.latest.version &&
  !item.action &&
  !item.latest.error &&
  !["running", "failed"].includes(item.tool.install?.state ?? "");

export const appCurrent = (app: DesktopUpdateStatus | undefined): boolean =>
  !!app && app.phase === "idle" && !app.updateVersion && !app.publishing;

export const gatewayCurrent = (snapshot: ui.UpdatesSnapshot): boolean =>
  !!snapshot.availableVersion &&
  !snapshot.gatewayUpdateAvailable &&
  !snapshot.checkError &&
  !snapshot.checking &&
  !updateBusy(snapshot.gatewayState) &&
  snapshot.gatewayState !== "failed";

/** Workers with their own row: the desktop app's bundled worker is part of "This Canopy app". */
export const listedWorkers = (snapshot: ui.UpdatesSnapshot): ui.WorkerUpdate[] =>
  snapshot.workers.filter((worker) => !worker.bundled);

export const updatesAvailable = (snapshot: ui.UpdatesSnapshot): boolean =>
  computerUpdatesAvailable(snapshot) ||
  (!snapshot.gatewayBundled && snapshot.gatewayInstallKind === "binary" && snapshot.gatewayUpdateAvailable) ||
  listedWorkers(snapshot).some((worker) =>
    worker.desktop
      ? worker.desktop.connected &&
        !worker.desktop.disabledReason &&
        !!worker.desktop.availableVersion &&
        worker.desktop.availableVersion !== worker.desktop.version
      : worker.installKind === "binary" &&
        !!worker.version &&
        worker.version !== snapshot.gatewayVersion &&
        worker.state !== "ahead",
  ) ||
  snapshot.cliWorkers.some(
    (worker) => snapshot.workers.some((w) => w.workerId === worker.id) && worker.cliTools.some(cliUpdateActionable),
  );

export const externalUpdatesAvailable = (snapshot: ui.UpdatesSnapshot): boolean =>
  (!snapshot.gatewayBundled && snapshot.gatewayInstallKind !== "binary" && snapshot.gatewayUpdateAvailable) ||
  listedWorkers(snapshot).some(
    (worker) =>
      worker.installKind !== "binary" &&
      !worker.desktop &&
      !!worker.version &&
      worker.version !== snapshot.gatewayVersion &&
      worker.state !== "ahead",
  ) ||
  snapshot.cliWorkers.some((worker) =>
    worker.cliTools.some((item) => item.updateAvailable && !cliUpdateActionable(item)),
  );
