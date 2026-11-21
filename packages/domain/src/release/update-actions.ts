import { CliInstallMethod, ui } from "@canopy/contracts";
import { isRateLimitMessage } from "./http.ts";
import { create } from "@bufbuild/protobuf";
import { canopyUpdateRun } from "./update-plan.ts";

export const MANUAL_APP_UPDATE = "Update this computer from its own window once to enable remote updates.";

/** The old action names on older gateways may also install provider CLIs. */
export const canopyUpdateAction = (action = ""): string =>
  ["update_all", "retry_failed", "retry_step"].includes(action) ? `canopy_${action}` : action;

export function updateControlMessage(message: string): string {
  const reason = message.replace(/^\[unavailable\]\s*/i, "");

  if (reason === "Gateway update control is starting") return "The gateway is starting. Try again in a moment.";

  if (reason === "Gateway update control is shutting down")
    return "The gateway is shutting down. Try again when it returns.";

  return reason === "Gateway update control is starting or shutting down"
    ? "Wait for the gateway to be ready, then try again."
    : "";
}

export function updateGatewayMessage(action: string, message: string): string {
  return action.startsWith("canopy_") && message === "Unknown update action"
    ? "Update Canopy on the gateway to use this action."
    : updateControlMessage(message);
}

/** Older gateways can return a durable plan that includes provider CLI steps. */
export const canopyUpdateSnapshot = (snapshot: ui.UpdatesSnapshot): ui.UpdatesSnapshot => ({
  ...snapshot,
  run: canopyUpdateRun(snapshot.run),
});

/** The connected gateway's desktop app, rendered with the same row as a linked computer. */
export function homeAppComputer(snapshot: ui.UpdatesSnapshot): ui.ComputerUpdate | undefined {
  if (!snapshot.gatewayBundled) return;

  return create(ui.ComputerUpdateSchema, {
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
      CliInstallMethod.ASDF,
      CliInstallMethod.YARN,
      CliInstallMethod.DOCKER,
      CliInstallMethod.OTHER,
    ].includes(item.tool.method));
