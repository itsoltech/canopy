import type { ui } from "@canopy/contracts";
import { compareVersions } from "@canopy/updater/release";

const newerVersion = (target: string, current: string): boolean => {
  try {
    return compareVersions(target, current) > 0;
  } catch {
    return false;
  }
};

/** A linked computer's app in the updates center: one status, its tone and whether Update applies. */
export interface ComputerUpdateView {
  status: string;
  current: boolean;
  busy: boolean;
  failed: boolean;
  actionable: boolean;
  target: string;
  detail: string;
  progress: number | undefined;
}

const UNREACHABLE = "It's unreachable. Its status shows when it's back.";

const PRESENCE = new Map([
  ["sleeping", "It's asleep. Its status shows when it wakes."],
  ["shutting_down", "It's shut down. Its status shows when it starts."],
  ["needs_update", "Its Canopy app is too old for this link. Update it on that computer."],
  ["pairing_required", "Link it again in Settings → Linked computers."],
]);

const PHASE = new Map([
  ["queued", "Queued"],
  ["checking", "Checking"],
  ["waiting_idle", "Waiting for idle"],
  ["restarting", "Restarting"],
  ["failed", "Failed"],
]);

export function computerUpdate(computer: ui.ComputerUpdate): ComputerUpdateView {
  const app = computer.updates?.app;
  const base = { current: false, busy: false, failed: false, actionable: false, target: "", progress: undefined };

  // Announced before it quit for an update: it comes back by itself.
  if (computer.presence === "updating")
    return { ...base, status: "Restarting", busy: true, detail: "It restarts to install the update." };

  if (computer.presence !== "connected")
    return {
      ...base,
      status: computer.presence === "needs_update" ? "Manual update" : "Offline",
      detail: PRESENCE.get(computer.presence) ?? UNREACHABLE,
    };

  if (!computer.remoteUpdate) return { ...base, status: "Manual update", detail: computer.reason };

  if (!app) return { ...base, status: "Unavailable", detail: "It didn't answer. Check again in a moment." };

  if (!app.connected || app.disabledReason) return { ...base, status: "Unavailable", detail: app.disabledReason };
  const newer = newerVersion(app.availableVersion, app.version);
  const target = app.targetVersion || (newer ? app.availableVersion : "");
  const busy = ["queued", "checking", "downloading", "waiting_idle", "restarting"].includes(app.phase);
  const failed = app.phase === "failed";

  return {
    status:
      app.phase === "downloading"
        ? `${Math.round(app.progress)}%`
        : (PHASE.get(app.phase) ?? (app.ready ? "Ready" : newer ? "Available" : "Up to date")),
    current: !busy && !failed && !newer && !app.ready,
    busy,
    failed,
    actionable: !busy && (newer || app.ready),
    target,
    detail:
      app.phase === "waiting_idle"
        ? "It restarts after its current turns end."
        : failed
          ? app.reason
          : app.ready && !busy
            ? "The update is downloaded. Update restarts it after its current turns end."
            : "",
    progress: app.phase === "downloading" ? app.progress : undefined,
  };
}

/** Linked computers whose app Update all or the row's action can update now. */
export const computerUpdatesAvailable = (snapshot: ui.UpdatesSnapshot): boolean =>
  snapshot.computers.some((c) => computerUpdate(c).actionable);

/** The snapshots of this computer and every linked computer that answered, each with its computer's name. */
export function homes(snapshot: ui.UpdatesSnapshot): { name: string; nodeId: string; home: ui.UpdatesSnapshot }[] {
  return [
    { name: "This computer", nodeId: "", home: snapshot },
    ...snapshot.computers.flatMap((c) => (c.updates ? [{ name: c.name, nodeId: c.nodeId, home: c.updates }] : [])),
  ];
}
