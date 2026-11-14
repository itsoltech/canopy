import type { ui } from "@canopy/contracts";
import { remoteStepCurrent, remoteStepDismissed } from "./remote-outcome.ts";

/** A peer's own app updater runs there; wait for its return or a confirmed result. */
export function computerUpdated(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot): boolean {
  const computer = snapshot.computers.find((item) => item.nodeId === step.nodeId);

  if (!computer) throw new Error("This computer is no longer linked");
  const app = computer.updates?.app;

  if (computer.presence !== "connected" || !app?.connected) return false;

  if (remoteStepCurrent(step, snapshot)) return true;

  if (remoteStepDismissed(step, snapshot))
    throw new Error("The app update was dismissed. Request it again to continue.");

  if (app.requestId === step.requestId && app.phase === "failed") throw new Error(app.reason || "App update failed");

  return false;
}
