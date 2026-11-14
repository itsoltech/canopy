import type { ui } from "@canopy/contracts";

/** The same compact counters in the updates popover and mobile sheet. */
export function updateProgress(run: ui.UpdateRun) {
  const active = run.steps.filter((step) => step.state === "running").length;
  const done = run.steps.filter((step) => step.state === "succeeded").length;
  const failed = run.steps.filter((step) => ["failed", "blocked"].includes(step.state)).length;
  const total = run.steps.filter((step) => step.state !== "skipped").length;

  return { completed: done + failed, total, label: `Updating ${active} · ${done} done · ${failed} failed` };
}
