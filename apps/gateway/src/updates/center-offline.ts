import type { ui } from "@canopy/contracts";
import { DEPARTURE_WINDOW_MS } from "@canopy/domain/computer-presence";
import { knownUpdateOffline } from "@canopy/domain/release/update-offline";
import { restartsUpdateTarget } from "./center-scheduling.ts";

const RECONNECT_MS = 60_000;

function restarting(update: ui.UpdateStep, snapshot: ui.UpdatesSnapshot): boolean {
  const peer = snapshot.computers.find((item) => item.nodeId === update.nodeId);
  const home = update.nodeId ? peer?.updates : snapshot;
  const worker = home?.workers.find((item) => item.workerId === update.workerId);

  switch (update.kind) {
    case "app":
      // A freshly restarted local gateway does not have the app controller's first report yet.
      return !snapshot.app?.version || snapshot.app.phase === "restarting";
    case "gateway":
      return snapshot.gatewayState === "restarting";
    case "computer":
      return ["updating", "restarting"].includes(peer?.presence ?? "") || home?.app?.phase === "restarting";
    case "desktop":
      return worker?.desktop?.phase === "restarting";
    case "worker":
      return worker?.state === "restarting";
    default:
      return false;
  }
}

/** Keep an announced restart's grace relative to the disconnect, even after a long download or idle wait. */
export class UpdateReconnects {
  private readonly since = new Map<string, number>();

  clear() {
    this.since.clear();
  }

  /** Defer a reconnecting target, or finish a known-offline step with its reason. */
  deferOrSkip(step: ui.UpdateStep, key: string, run: ui.UpdateRun, snapshot: ui.UpdatesSnapshot): boolean {
    const reason = knownUpdateOffline(step, snapshot);
    const peer = step.nodeId ? snapshot.computers.find((item) => item.nodeId === step.nodeId) : undefined;

    if (!reason) {
      this.since.delete(key);

      // The coordinator's process can come back before its first peer snapshot finishes loading.
      if (step.state !== "queued" || !step.nodeId || (peer?.updates && (!peer.readState || peer.readState === "fresh")))
        return false;
    }

    const now = Date.now();

    const canReconnect = !peer || !["sleeping", "shutting_down", "pairing_required"].includes(peer.presence);

    if (canReconnect) {
      for (const update of run.steps) {
        if (!restartsUpdateTarget(update, step)) continue;

        if (update.state === "succeeded" && now - Date.parse(update.finishedAt) < RECONNECT_MS) return true;

        if (reason && update.state === "running") {
          // The control stream may close before the last restart report reaches the gateway.
          const grace = restarting(update, snapshot) ? DEPARTURE_WINDOW_MS : RECONNECT_MS;
          const since = this.since.get(key) ?? now;
          this.since.set(key, since);

          if (now - since < grace) return true;
        }
      }
    }

    if (!reason) return false;
    this.since.delete(key);
    step.state = "skipped";
    step.reason = reason;
    step.finishedAt = new Date(now).toISOString();

    return true;
  }
}
