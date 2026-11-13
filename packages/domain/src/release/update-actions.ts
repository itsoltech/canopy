import { CliInstallMethod, type ui } from "@canopy/contracts";
import { isRateLimitMessage } from "./http.ts";
import { create } from "@bufbuild/protobuf";
import { ui as contracts } from "@canopy/contracts";

export const MANUAL_APP_UPDATE = "Update this computer from its own window once to enable remote updates.";

/** The connected gateway's desktop app, rendered with the same row as a linked computer. */
export function homeAppComputer(snapshot: ui.UpdatesSnapshot): ui.ComputerUpdate | undefined {
  if (!snapshot.gatewayBundled) return;

  return create(contracts.ComputerUpdateSchema, {
    name: snapshot.computerName || "Canopy on this computer",
    version: snapshot.gatewayVersion,
    presence: "connected",
    remoteUpdate: snapshot.appUpdateSupported,
    reason: snapshot.appUpdateSupported ? "" : MANUAL_APP_UPDATE,
    updates: snapshot,
  });
}

/** Names of turns affected by a desktop restart; includes starts, questions and background work. */
export function appRunningTurns(threads: readonly ui.Thread[], workerId: string): string[] {
  return threads.flatMap((thread) =>
    !!workerId &&
    thread.workerId === workerId &&
    (thread.turnStarting ||
      ["running", "waiting_input"].includes(thread.status) ||
      thread.backgroundTasks > 0 ||
      thread.titleGenerating)
      ? [thread.title || "Untitled thread"]
      : [],
  );
}

export function appRestartDescription(name: string, turns: readonly string[], client: "phone" | "web"): string {
  const work = turns.length
    ? `It waits for these turns to finish.\n\nRunning ${turns.length === 1 ? "turn" : "turns"} (${turns.length.toLocaleString()}):\n${turns.map((title) => `“${title}”`).join("\n")}`
    : "It waits for any running turns to finish.";

  return `“${name}” restarts to install the update. ${client === "phone" ? "This phone reconnects" : "Canopy reconnects"} automatically. ${work}`;
}

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

/** Match the gateway's installer support, including managers with a supported update recipe. */
export const cliManagedExternally = (item: ui.WorkerCliTool): boolean =>
  !!item.tool &&
  (!item.tool.installable ||
    !!item.managedBy ||
    [
      CliInstallMethod.HOMEBREW,
      CliInstallMethod.MISE,
      CliInstallMethod.ASDF,
      CliInstallMethod.YARN,
      CliInstallMethod.DOCKER,
      CliInstallMethod.OTHER,
    ].includes(item.tool.method));

export const cliUpdateActionable = (item: ui.WorkerCliTool): boolean =>
  !!item.tool?.installable &&
  !cliManagedExternally(item) &&
  item.action === "update" &&
  !item.blockedReason.includes("owner");
