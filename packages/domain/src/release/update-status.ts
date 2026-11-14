import type { ui } from "@canopy/contracts";

/**
 * One vocabulary for every update row on web and mobile (docs/updates.md, "Popover aktualizacji"). Settled states are
 * quiet; green is only for what was just updated.
 */
export type UpdateStatus =
  | "current"
  | "available"
  | "downloaded"
  | "queued"
  | "starting"
  | "updating"
  | "waiting"
  | "restarting"
  | "updated"
  | "failed";

export type UpdateBadgeTone = "quiet" | "neutral" | "sky" | "amber" | "emerald" | "rose";

export const UPDATE_BADGES: Record<UpdateStatus, { label: string; tone: UpdateBadgeTone }> = {
  current: { label: "Up to date", tone: "quiet" },
  available: { label: "Available", tone: "sky" },
  downloaded: { label: "Downloaded", tone: "sky" },
  queued: { label: "Queued", tone: "neutral" },
  starting: { label: "Starting", tone: "amber" },
  updating: { label: "Updating", tone: "amber" },
  waiting: { label: "Waiting", tone: "amber" },
  restarting: { label: "Restarting", tone: "amber" },
  updated: { label: "Updated", tone: "emerald" },
  failed: { label: "Failed", tone: "rose" },
};

/** States that show the row's bar. */
export const updateInProgress = (status: UpdateStatus | string): boolean =>
  ["starting", "updating", "waiting", "restarting"].includes(status);

const RANK: Record<UpdateStatus, number> = {
  current: 0,
  available: 0,
  downloaded: 0,
  queued: 1,
  starting: 2,
  updating: 3,
  waiting: 4,
  restarting: 5,
  updated: 6,
  failed: 6,
};

/** A shared word; anything else is an edge state that explains itself (Offline, Manual update…). */
export const isUpdateStatus = (value: string | undefined): value is UpdateStatus => !!value && value in RANK;

/** Edge states keep their own words (Offline, Manual update, Checks paused…) in a neutral badge. */
export function updateBadge(status: UpdateStatus | string): { label: string; tone: UpdateBadgeTone } {
  return isUpdateStatus(status) ? UPDATE_BADGES[status] : { label: status, tone: "neutral" };
}

/**
 * While a run is active a row shows the further of its run step and its own report, so a late read of the target
 * never moves it back (Updating → Queued). Edge states of the row itself (Offline…) win over a pending step.
 */
export function furthestStatus(own: UpdateStatus | string, run: UpdateStatus | undefined): UpdateStatus | string {
  if (!run) return own;

  if (!isUpdateStatus(own)) return run === "updated" || run === "failed" ? run : own;

  // A finished update does not hide a newer one that became available since.
  if (run === "updated" && own !== "current" && RANK[own] === 0) return own;

  return RANK[run] > RANK[own] ? run : own;
}

/** "Updated" and the finished summary stay for an hour; then the row is simply up to date. */
export const UPDATED_FRESH_MS = 60 * 60_000;

/** An announced restart longer than this is overdue: only then does the row warn. */
export const RESTART_WARNING_MS = 3 * 60_000;

export interface UpdateTarget {
  kind: string;
  nodeId?: string | undefined;
  workerId?: string | undefined;
  provider?: number | undefined;
}

/** The row an Update all step belongs to: the same key from a step and from the row that shows it. */
export const updateTargetKey = (target: UpdateTarget): string =>
  [target.kind, target.nodeId ?? "", target.workerId ?? "", target.provider ?? 0].join("/");

const fresh = (at: string, now: number) => !!at && now - Date.parse(at) < UPDATED_FRESH_MS;

function stepStatus(step: ui.UpdateStep, now: number): UpdateStatus | undefined {
  if (step.state === "queued") return "queued";

  if (step.state === "running") return "updating";

  if (step.state === "succeeded") return fresh(step.finishedAt, now) ? "updated" : undefined;

  if (step.state === "failed" || step.state === "blocked") return "failed";

  return undefined;
}

/** Each row's state from the current run; superseded and dismissed runs no longer speak for any row. */
export function runStatuses(run: ui.UpdateRun | undefined, now = Date.now()): Map<string, UpdateStatus> {
  const statuses = new Map<string, UpdateStatus>();

  if (!run || ["superseded", "dismissed"].includes(run.state)) return statuses;

  for (const step of run.steps) {
    const status = stepStatus(step, now);

    if (status) statuses.set(updateTargetKey(step), status);
  }

  return statuses;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The popover's one summary of a run: a single counter (finished of planned, failures only when there are some) and
 * the bar's value. Undefined when the run has nothing left to say.
 */
export function updateRunSummary(
  run: ui.UpdateRun | undefined,
  now = Date.now(),
): { text: string; tone: "ink" | "rose"; progress: number | undefined } | undefined {
  if (!run || ["superseded", "dismissed"].includes(run.state)) return undefined;
  const steps = run.steps.filter((step) => !["skipped", "dismissed"].includes(step.state));
  const succeeded = steps.filter((step) => step.state === "succeeded").length;
  const failed = steps.filter((step) => ["failed", "blocked"].includes(step.state)).length;
  const done = succeeded + failed;

  if (run.state === "running")
    return {
      text: `Updating · ${done} of ${steps.length} done${failed ? ` · ${failed} failed` : ""}`,
      tone: "ink",
      progress: steps.length ? (done / steps.length) * 100 : 0,
    };

  if (failed)
    return {
      text: `${plural(failed, "update")} failed${succeeded ? ` · ${succeeded} updated` : ""}`,
      tone: "rose",
      progress: undefined,
    };

  const finished = steps.reduce((latest, step) => (step.finishedAt > latest ? step.finishedAt : latest), "");

  if (run.state === "succeeded" && succeeded && fresh(finished, now))
    return {
      text: succeeded === 1 ? "1 update finished" : `All ${succeeded} updates finished`,
      tone: "ink",
      progress: undefined,
    };

  return undefined;
}

/** A computer restarting for its own update: calm until it is overdue. */
export function restartDetail(sinceMs: bigint | number, now = Date.now()) {
  const since = Number(sinceMs);
  const elapsed = since ? now - since : 0;

  if (elapsed < RESTART_WARNING_MS) return { text: "Restarting to update…", overdue: false };

  return {
    text: `Still restarting after ${Math.round(elapsed / 60_000)} min. Check that computer.`,
    overdue: true,
  };
}
