import type { ui } from "@canopy/contracts";
import { copySize } from "./workspace-copy.ts";

/** Background copies the gateway still runs; they continue without any client. */
export const copyJobRunning = (job: ui.WorkspaceCopyJob) =>
  ["queued", "copying", "finishing", "waiting"].includes(job.status);

/** What the sidebar lists: running copies and failed ones (they offer Retry). Finished ones show a toast. */
export const copyJobListed = (job: ui.WorkspaceCopyJob) => copyJobRunning(job) || job.status === "failed";

export function copyJobPercent(job: ui.WorkspaceCopyJob): number {
  const progress = job.progress;

  if (job.status === "completed") return 100;

  return progress?.totalBytes ? Number((progress.bytes * 100n) / progress.totalBytes) : 0;
}

/** "Copying web-app → nix-pc", the row's title in every client. */
export function copyJobTitle(job: ui.WorkspaceCopyJob): string {
  let verb = "Copying";

  if (job.status === "failed") verb = "Copy failed:";
  else if (job.status === "completed") verb = "Copied";

  return `${verb} ${job.name} → ${job.targetName || "worker"}`;
}

/** The short state at the row's end: a percentage while it copies, otherwise one word. */
export function copyJobState(job: ui.WorkspaceCopyJob): string {
  switch (job.status) {
    case "queued":
      return "Queued";
    case "waiting":
      return "Waiting";
    case "finishing":
      return "Finishing";
    case "failed":
      return "Failed";
    case "completed":
      return "Done";
    case "cancelled":
      return "Cancelled";
    default:
      return `${copyJobPercent(job)}%`;
  }
}

/** "3.1 MB / 63.4 MB · 329 / 3,975 files". */
export function copyJobAmounts(job: ui.WorkspaceCopyJob): string {
  const p = job.progress;

  if (!p?.totalFiles) return job.status === "queued" ? "Starts when another copy ends." : "Preparing the destination…";

  return `${copySize(p.bytes)} / ${copySize(p.totalBytes)} · ${p.files.toLocaleString()} / ${p.totalFiles.toLocaleString()} files`;
}

/** Applies one overview change; returns the next list, or undefined when the change is about something else. */
export function applyCopyJobChange(
  jobs: ReadonlyMap<string, ui.WorkspaceCopyJob>,
  update: ui.OverviewUpdate,
): Map<string, ui.WorkspaceCopyJob> | undefined {
  const change = update.change;

  if (change.case === "workspaceCopyJob") return new Map(jobs).set(change.value.id, change.value);

  if (change.case === "workspaceCopyJobRemoved") {
    const next = new Map(jobs);
    next.delete(change.value);

    return next;
  }

  return undefined;
}
