import type { ui } from "@canopy/contracts";
import { compareVersions } from "@canopy/updater/release";
import { presenceLabel, formatPresenceTime } from "@canopy/domain/computer-presence";
import { Match } from "effect";
import { appCheckPause } from "@canopy/domain/release/update-actions";
import { currentRemoteUpdate, reachedUpdateVersion } from "@canopy/domain/release/remote-update-state";

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
  ["shutting_down", "Its status shows when it reconnects."],
  ["needs_update", "Its Canopy app is too old for this link. Update it on that computer."],
  ["pairing_required", "Link it again in Settings → Linked computers."],
]);

/** Phases of an update this or another computer requested; the app's own updater shows while none runs. */
const REQUESTED = ["queued", "checking", "downloading", "waiting_idle", "restarting"];

const PHASE = new Map([
  ["queued", "Queued"],
  ["checking", "Checking"],
  ["waiting_idle", "Waiting for idle"],
  ["restarting", "Restarting"],
  ["failed", "Failed"],
]);

export function computerUpdate(computer: ui.ComputerUpdate, time = formatPresenceTime): ComputerUpdateView {
  const reported = computer.updates?.app;
  const app = reported && currentRemoteUpdate(reported);
  const base = { current: false, busy: false, failed: false, actionable: false, target: "", progress: undefined };
  const departure = computer.updates?.departure;

  // Announced before it quit for an update: it comes back by itself.
  if (computer.presence === "updating" || computer.presence === "restarting")
    return {
      ...base,
      status: presenceLabel(computer.presence, computer.presenceSinceMs, time),
      busy: true,
      detail: "It reconnects automatically.",
    };

  if (computer.presence !== "connected")
    return {
      ...base,
      status:
        computer.presence === "needs_update"
          ? "Manual update"
          : presenceLabel(computer.presence, computer.presenceSinceMs, time),
      detail: PRESENCE.get(computer.presence) ?? UNREACHABLE,
    };

  const failedDeparture = !!(
    departure &&
    ["failed", "rolled_back"].includes(departure.state) &&
    !reachedUpdateVersion(app?.version || computer.version, departure.targetVersion) &&
    !REQUESTED.includes(app?.phase ?? "") &&
    !["checking", "downloading"].includes(app?.updaterPhase ?? "") &&
    !(app?.phase === "succeeded" && app.targetVersion === departure.targetVersion)
  );

  if (failedDeparture && !app)
    return {
      ...base,
      status: departure?.state === "rolled_back" ? "Rolled back" : "Failed",
      failed: true,
      target: departure?.targetVersion ?? "",
      detail: departure?.reason || "The update did not finish. Check again to retry.",
    };

  if (!computer.remoteUpdate) return { ...base, status: "Manual update", detail: computer.reason };

  if (!app)
    return {
      ...base,
      status: Match.value(computer.readState).pipe(
        Match.when("loading", () => "Loading"),
        Match.when("stale", () => "Waiting"),
        Match.orElse(() => "Unavailable"),
      ),
      detail: computer.reason || `Waiting for ${computer.name}. Local updates are ready.`,
    };

  if (!app.connected || app.disabledReason) return { ...base, status: "Unavailable", detail: app.disabledReason };
  const requested = REQUESTED.includes(app.phase);
  // Its own updater, unless a requested update runs or failed; empty from apps that don't report it.
  const own = requested || app.phase === "failed" ? "" : app.updaterPhase;
  const paused = appCheckPause(app);

  if (paused && !failedDeparture) return { ...base, status: "Checks paused", detail: paused };
  const downloading = app.phase === "downloading" || own === "downloading";
  const ready = app.ready || own === "downloaded";

  // A finished request keeps the version it installed; only a running or failed one still aims at it.
  const target = [
    requested || app.phase === "failed" ? app.targetVersion : "",
    failedDeparture ? departure?.targetVersion : "",
    app.updaterVersion,
    app.availableVersion,
  ]
    .filter(Boolean)
    .find((version) => version && newerVersion(version, app.version));

  const busy = requested || own === "checking" || own === "downloading";
  const failed = app.phase === "failed" || own === "error" || failedDeparture;
  const progress = app.phase === "downloading" ? app.progress : own === "downloading" ? app.updaterProgress : 0;

  return {
    // The same words as "This Canopy app" (CompactAppUpdate.svelte).
    status: downloading
      ? `${Math.round(progress)}%`
      : failedDeparture
        ? departure?.state === "rolled_back"
          ? "Rolled back"
          : "Failed"
        : (PHASE.get(app.phase) ??
          (own === "error"
            ? "Failed"
            : own === "checking"
              ? "Checking"
              : ready
                ? "Ready"
                : target
                  ? "Available"
                  : "Up to date")),
    current: !busy && !failed && !target && !ready,
    busy,
    failed,
    actionable: !busy && (!!target || ready),
    target: target ?? "",
    detail: failedDeparture
      ? departure?.reason || "The update did not finish. Check again to retry."
      : app.phase === "waiting_idle"
        ? "It restarts after its current turns end."
        : app.phase === "failed"
          ? app.reason
          : own === "error"
            ? app.updaterError || "Its app update failed. Check again to retry."
            : ready && !busy
              ? "The update is downloaded. Update restarts it after its current turns end."
              : "",
    progress: downloading ? progress : undefined,
  };
}

/** A linked computer's app is downloading: the updates center reloads faster, so its bar moves. */
export const linkedDownloading = (snapshot: ui.UpdatesSnapshot | undefined): boolean =>
  !!snapshot?.computers.some((c) => computerUpdate(c).progress !== undefined);

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
