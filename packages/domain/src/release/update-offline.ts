import type { ui } from "@canopy/contracts";

/** Check the transport that actually carries the command. A retained peer snapshot cannot prove its worker is offline. */
export function knownUpdateOffline(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot): string {
  const peer = step.nodeId ? snapshot.computers.find((item) => item.nodeId === step.nodeId) : undefined;

  if (step.nodeId) {
    if (!peer) return "";

    if (
      ["sleeping", "shutting_down", "unreachable", "offline", "pairing_required", "updating", "restarting"].includes(
        peer.presence,
      )
    )
      return peer.reason || `${peer.name || "This computer"} is offline. Reconnect it and retry Update all.`;

    if (peer.presence !== "connected" || peer.readState !== "fresh") return "";
  }

  const home = peer ? peer.updates : snapshot;
  const worker = home?.workers.find((item) => item.workerId === step.workerId);

  if (step.kind === "worker" && worker && !worker.connected)
    return "The worker's update channel is offline. Reconnect it and retry Update all.";

  const app =
    step.kind === "desktop" ? worker?.desktop : ["computer", "app"].includes(step.kind) ? home?.app : undefined;

  return app && !app.connected
    ? app.disabledReason || "Desktop app is offline. Open Canopy on that computer and reconnect."
    : "";
}
