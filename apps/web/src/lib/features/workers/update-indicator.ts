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

  const failed =
    error ||
    snapshot?.checkError ||
    (app?.phase === "error" ? app.message : "") ||
    (["failed", "blocked"].includes(run?.state ?? "") ? run?.reason : "") ||
    (snapshot?.gatewayState === "failed" ? snapshot.gatewayReason : "") ||
    workers.find((w) => w.state === "failed")?.reason ||
    workers.find((w) => w.desktop?.phase === "failed")?.desktop?.reason ||
    clis.find((t) => t.tool?.install?.state === "failed")?.tool?.install?.error;

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
    return { phase: "ready", message: "Canopy app is ready — open to restart", progress: 100 };

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
    return { phase: "available", message: "Updates available — open the updates center", progress: undefined };

  return { phase: "quiet", message: app?.publishing || "No new updates available", progress: undefined };
}
