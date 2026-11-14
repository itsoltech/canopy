import { bulkUpdateSteps } from "@canopy/domain/release/update-plan";
import { updateRunSummary } from "@canopy/domain/release/update-status";
import { updateCheckLabel } from "@canopy/domain/computer-presence";
import type { DesktopUpdatesState } from "#lib/features/desktop/desktop-updates.svelte.ts";
import { presenceTime } from "#lib/features/computers/computers.ts";
import type { UpdatesState } from "./updates.svelte.ts";
import { updateIndicator } from "./update-indicator.ts";

export interface UpdatesHeadline {
  text: string;
  tone: "ink" | "muted" | "rose";
  /** The run's bar under the header; undefined hides it. */
  progress: number | undefined;
}

/**
 * The popover's one summary (docs/updates.md): what the user just started, else the run's single counter, else the
 * settled state with the last check time. Rows never repeat it.
 */
export function updatesHeadline(updates: UpdatesState, app: DesktopUpdatesState, checking: boolean): UpdatesHeadline {
  const snapshot = updates.snapshot;
  const line = (text: string, tone: UpdatesHeadline["tone"] = "ink", progress?: number) => ({ text, tone, progress });

  if (updates.optimistic && updates.pending && updates.pending !== "check")
    return line("Starting update…", "ink", updates.optimistic.run ? 0 : undefined);
  const run = updateRunSummary(updates.run);

  if (run?.progress !== undefined || run?.tone === "rose") return line(run.text, run.tone, run.progress);

  if (checking) return line("Checking for updates…", "muted");

  if (run) return line(run.text, run.tone);

  const summary = updateIndicator(app.status, snapshot, app.error || updates.error, updates.pending, app.remote);

  const planned = snapshot ? bulkUpdateSteps(snapshot).filter((step) => step.state === "queued").length : 0;

  switch (summary.phase) {
    case "error":
      return line("Update failed", "rose");
    case "downloading":
      return line(app.status?.phase === "downloading" ? "Downloading an update…" : "Updating…");
    case "ready":
      return line("Restart to finish the update");
    case "available":
      return line(planned > 1 ? `${planned} updates available` : planned ? "1 update available" : "Updates available");
    case "paused":
      return line(summary.message, "muted");
    case "external":
      return line("Updates available outside Canopy", "muted");
    default: {
      const checked = app.status?.lastCheckedAt || snapshot?.app?.lastCheckedAtMs;

      return line(checked ? `Up to date · ${updateCheckLabel(checked, presenceTime)}` : "Up to date", "muted");
    }
  }
}
