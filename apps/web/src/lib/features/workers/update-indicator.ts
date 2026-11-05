import type { DesktopUpdateStatus } from "@canopy/ui/desktop";
import type { ui } from "@canopy/contracts";

export function updateIndicator(
  app: DesktopUpdateStatus | undefined,
  snapshot: ui.UpdatesSnapshot | undefined,
  error: string,
  pending = "",
) {
  const workers = snapshot?.workers ?? [];
  const clis = snapshot?.cliWorkers.flatMap((w) => w.cliTools) ?? [];
  const run = snapshot?.run;
  const failedWorker = workers.find((w) => w.state === "failed");
  const failedDesktop = workers.find((w) => w.desktop?.phase === "failed")?.desktop;
  const failedCli = clis.find((t) => t.tool?.install?.state === "failed");

  const failed =
    error ||
    snapshot?.checkError ||
    (app?.phase === "error" ? app.message || "App update failed" : "") ||
    (["failed", "blocked"].includes(run?.state ?? "") ? run?.reason || "Updates stopped" : "") ||
    (snapshot?.gatewayState === "failed" ? snapshot.gatewayReason || "Gateway update failed" : "") ||
    (failedWorker ? failedWorker.reason || "Worker update failed" : "") ||
    (failedDesktop ? failedDesktop.reason || "Desktop update failed" : "") ||
    (failedCli ? failedCli.tool?.install?.error || "Agent CLI update failed" : "");

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
    clis.some((t) => t.tool?.install?.state === "running");

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

  if (
    snapshot?.gatewayUpdateAvailable ||
    workers.some((w) => w.installKind === "binary" && w.version !== snapshot?.gatewayVersion && w.state !== "ahead") ||
    clis.some((t) => !!t.action) ||
    workers.some((w) => !!w.desktop?.availableVersion && w.desktop.availableVersion !== w.desktop.version)
  )
    return { phase: "available", message: "Updates available", progress: undefined };

  return { phase: "quiet", message: app?.publishing || "Up to date", progress: undefined };
}
