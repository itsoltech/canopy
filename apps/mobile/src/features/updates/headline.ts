import type { ui } from "@canopy/contracts";
import { updateCheckLabel } from "@canopy/domain/computer-presence";
import { bulkUpdateSteps } from "@canopy/domain/release/update-plan";
import { updateRunSummary } from "@canopy/domain/release/update-status";
import { presenceTime } from "../computers/presence";
import { updatesAvailable, updatesRunning } from "./model";

export interface SheetHeadline {
  text: string;
  tone: "ink" | "muted" | "rose";
  /** The run's bar under the header; undefined hides it. */
  progress: number | undefined;
}

/**
 * Web: updatesHeadline. The sheet's one summary: what the user just started, else the run's single counter, else the
 * settled state with the last check time. Rows never repeat it.
 */
export function sheetHeadline({
  snapshot,
  run,
  starting,
  checking,
  phoneUpdate,
}: {
  snapshot: ui.UpdatesSnapshot | undefined;
  run: ui.UpdateRun | undefined;
  starting: boolean;
  checking: boolean;
  phoneUpdate: boolean;
}): SheetHeadline {
  const line = (text: string, tone: SheetHeadline["tone"] = "ink", progress?: number) => ({ text, tone, progress });

  if (starting) return line("Starting update…", "ink", 0);
  const summary = updateRunSummary(run);

  if (summary?.progress !== undefined || summary?.tone === "rose")
    return line(summary.text, summary.tone, summary.progress);

  if (checking) return line("Checking for updates…", "muted");

  if (summary) return line(summary.text, summary.tone);

  // The body says it is loading; the header has nothing to add yet.
  if (!snapshot) return line("", "muted");

  if (updatesRunning(snapshot)) return line("Updating…");
  const planned = bulkUpdateSteps(snapshot).filter((step) => step.state === "queued").length;

  if (planned) return line(planned === 1 ? "1 update available" : `${planned} updates available`);

  if (updatesAvailable(snapshot) || phoneUpdate) return line("Updates available");
  const checked = snapshot.app?.lastCheckedAtMs;

  return line(checked ? `Up to date · ${updateCheckLabel(checked, presenceTime)}` : "Up to date", "muted");
}
