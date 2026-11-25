import type { ui } from "@canopy/contracts";
import { updateBusy } from "./updates.svelte.ts";

export { bulkUpdatesAvailable as updatesAvailable, externalUpdatesAvailable } from "@canopy/domain/release/update-plan";

export function workerCurrent(worker: ui.WorkerUpdate, gatewayVersion: string): boolean {
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

  if (worker.state === "failed" || updateBusy(worker.state) || worker.compatibility !== "compatible") return false;

  return worker.connected && !!worker.version && worker.version === gatewayVersion;
}

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
