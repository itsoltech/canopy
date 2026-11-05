import type { DesktopUpdateStatus } from "@canopy/ui/desktop";
import type { ui } from "@canopy/contracts";
import { listedWorkers, updatesAvailable, externalUpdatesAvailable } from "./compact-updates.ts";
import { computerUpdate } from "./computer-updates.ts";

export function updateIndicator(
  app: DesktopUpdateStatus | undefined,
  snapshot: ui.UpdatesSnapshot | undefined,
  error: string,
  pending = "",
) {
  const workers = snapshot ? listedWorkers(snapshot) : [];
  const clis = snapshot?.cliWorkers.flatMap((w) => w.cliTools) ?? [];
  const run = snapshot?.run;
  const failedWorker = workers.find((w) => w.state === "failed");
  const failedDesktop = workers.find((w) => w.desktop?.phase === "failed")?.desktop;
  const failedCli = clis.find((t) => t.tool?.install?.state === "failed");
  const computers = snapshot?.computers.map((c) => ({ name: c.name, view: computerUpdate(c) })) ?? [];
  const failedComputer = computers.find((c) => c.view.failed);

  const failed =
    error ||
    snapshot?.checkError ||
    (app?.phase === "error" ? app.message || "App update failed" : "") ||
    (["failed", "blocked"].includes(run?.state ?? "") ? run?.reason || "Updates stopped" : "") ||
    (snapshot?.gatewayState === "failed" && !snapshot.gatewayBundled
      ? snapshot.gatewayReason || "Gateway update failed"
      : "") ||
    (failedWorker ? failedWorker.reason || "Worker update failed" : "") ||
    (failedDesktop ? failedDesktop.reason || "Desktop update failed" : "") ||
    (failedCli ? failedCli.tool?.install?.error || "Agent CLI update failed" : "") ||
    (failedComputer ? `${failedComputer.name}: ${failedComputer.view.detail || "App update failed"}` : "");

  if (failed) return { phase: "error", message: failed, progress: undefined };

  const downloading =
    app?.phase === "downloading" ||
    run?.state === "running" ||
    ["waiting_idle", "downloading", "restarting"].includes(snapshot?.gatewayState ?? "") ||
    workers.some(
      (w) =>
        ["queued", "waiting_idle", "downloading", "restarting"].includes(w.state) ||
        ["queued", "waiting_idle", "downloading", "restarting"].includes(w.desktop?.phase ?? ""),
    ) ||
    clis.some((t) => t.tool?.install?.state === "running") ||
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
          : workers.find((w) => w.desktop?.phase === "downloading")?.desktop?.progress,
    };

  if (app?.phase === "downloaded")
    return { phase: "ready", message: "Canopy update ready. Restart to install it.", progress: 100 };

  if (
    app?.phase === "checking" ||
    snapshot?.checking ||
    pending === "check" ||
    workers.some((w) => w.desktop?.phase === "checking") ||
    (!snapshot && !app)
  )
    return { phase: "checking", message: "Checking for updates", progress: undefined };

  if (snapshot && updatesAvailable(snapshot))
    return { phase: "available", message: "Updates available", progress: undefined };

  if (snapshot && externalUpdatesAvailable(snapshot))
    return { phase: "external", message: "Updates available outside Canopy", progress: undefined };

  return { phase: "quiet", message: app?.publishing || "Up to date", progress: undefined };
}
