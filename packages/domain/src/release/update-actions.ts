import { CliInstallMethod, type ui } from "@canopy/contracts";
import { isRateLimitMessage } from "./http.ts";

/** A deferred discovery check must not turn a linked app into a failed installation. */
export function appCheckPause(app: ui.DesktopUpdateState | undefined): string {
  if (
    !app ||
    app.ready ||
    ["queued", "checking", "downloading", "waiting_idle", "restarting"].includes(app.phase) ||
    ["checking", "downloading"].includes(app.updaterPhase) ||
    (app.phase === "failed" && !isRateLimitMessage(app.reason)) ||
    (app.updaterPhase === "error" && !isRateLimitMessage(app.updaterError))
  )
    return "";

  return [app.updaterError, app.reason].find(isRateLimitMessage) ?? "";
}

/** Bulk updates leave installed CLIs owned by package managers to those managers. */
export const cliManagedExternally = (item: ui.WorkerCliTool): boolean =>
  !!item.tool &&
  ![CliInstallMethod.NATIVE, CliInstallMethod.NOT_INSTALLED, CliInstallMethod.UNSPECIFIED].includes(item.tool.method);

export const cliUpdateActionable = (item: ui.WorkerCliTool): boolean =>
  item.tool?.method === CliInstallMethod.NATIVE &&
  item.tool.installable &&
  item.action === "update" &&
  !item.blockedReason.includes("owner");
