import type { DesktopUpdateStatus } from "@canopy/ui/desktop";
import type { ui } from "@canopy/contracts";
import { listedWorkers, updatesAvailable, externalUpdatesAvailable } from "./compact-updates.ts";
import { computerUpdate, homes } from "@canopy/domain/release/computer-update";
import { isRateLimitMessage } from "@canopy/domain/release/http";
import { homeAppComputer } from "@canopy/domain/release/update-actions";
import { gatewayUpdateLifecycle } from "@canopy/domain/release/update-status";
import { updateBusy, workerUpdateOffline } from "./updates.svelte.ts";

export function gatewayUpdateActivity(state: string | undefined, gatewayTransition: boolean): string {
  if (gatewayUpdateLifecycle(state)) return state === "starting" ? "Gateway starting…" : "Gateway shutting down…";

  return gatewayTransition ? "Waiting for the gateway…" : "";
}

export function updateIndicator(
  app: DesktopUpdateStatus | undefined,
  snapshot: ui.UpdatesSnapshot | undefined,
  error: string,
  pending = "",
  remoteApp = false,
  gatewayTransition = false,
) {
  const gatewayActivity = gatewayUpdateActivity(snapshot?.gatewayState, gatewayTransition);

  if (gatewayActivity) return { phase: "downloading", message: gatewayActivity, progress: undefined };

  const workers = snapshot ? homes(snapshot).flatMap(({ home }) => listedWorkers(home)) : [];
  const run = snapshot?.run;
  const failedWorker = workers.find((w) => w.connected && w.state === "failed");
  const failedDesktop = workers.find((w) => w.desktop?.phase === "failed")?.desktop;
  const home = snapshot && (!app || remoteApp) ? homeAppComputer(snapshot) : undefined;

  const computers = [...(home ? [home] : []), ...(snapshot?.computers ?? [])].map((c) => ({
    name: c.name,
    view: computerUpdate(c),
  }));

  const failedComputer = computers.find((c) => c.view.failed);

  const failed =
    error ||
    (isRateLimitMessage(snapshot?.checkError ?? "") ? "" : snapshot?.checkError) ||
    (app?.phase === "error" ? app.message || "App update failed" : "") ||
    (["failed", "blocked"].includes(run?.state ?? "") ? run?.reason || "Updates stopped" : "") ||
    (snapshot?.gatewayState === "failed" && !snapshot.gatewayBundled
      ? snapshot.gatewayReason || "Gateway update failed"
      : "") ||
    (failedWorker ? failedWorker.reason || "Worker update failed" : "") ||
    (failedDesktop ? failedDesktop.reason || "Desktop update failed" : "") ||
    (failedComputer ? `${failedComputer.name}: ${failedComputer.view.detail || "App update failed"}` : "");

  if (failed) return { phase: "error", message: failed, progress: undefined };

  const downloading =
    app?.phase === "downloading" ||
    run?.state === "running" ||
    updateBusy(snapshot?.gatewayState ?? "") ||
    workers.some((w) => (!workerUpdateOffline(w) && updateBusy(w.state)) || updateBusy(w.desktop?.phase ?? "")) ||
    computers.some((c) => c.view.busy);

  if (downloading)
    return {
      phase: "downloading",
      message:
        app?.phase === "downloading"
          ? `Downloading Canopy app · ${Math.round(app.progress ?? 0)}%`
          : "Updates in progress",
      progress:
        app?.phase === "downloading"
          ? app.progress
          : (workers.find((w) => w.desktop?.phase === "downloading")?.desktop?.progress ??
            computers.find((c) => c.view.progress !== undefined)?.view.progress),
    };

  if (app?.phase === "downloaded" || app?.stagedVersion)
    return { phase: "ready", message: "Canopy update ready. Restart to install it.", progress: 100 };

  const paused = [
    app?.publishing ?? "",
    snapshot?.checkError ?? "",
    ...computers.map((c) => (c.view.status === "Checks paused" ? c.view.detail : "")),
  ].find(isRateLimitMessage);

  if (paused) return { phase: "paused", message: paused, progress: undefined };

  if (
    app?.phase === "checking" ||
    snapshot?.checking ||
    pending === "check" ||
    workers.some((w) => w.desktop?.phase === "checking") ||
    (!snapshot && !app)
  )
    return { phase: "checking", message: "Checking for updates", progress: undefined };

  if (snapshot && (updatesAvailable(snapshot) || computers.some((c) => c.view.actionable)))
    return { phase: "available", message: "Updates available", progress: undefined };

  if (snapshot && externalUpdatesAvailable(snapshot))
    return { phase: "external", message: "Updates available outside Canopy", progress: undefined };

  return { phase: "quiet", message: app?.publishing || "Up to date", progress: undefined };
}
