import type { ui } from "@canopy/contracts";

export const UPDATE_CONCURRENCY = 4;
export const pendingUpdate = (step: ui.UpdateStep): boolean => ["queued", "running"].includes(step.state);

export function succeedUpdate(step: ui.UpdateStep) {
  step.state = "succeeded";
  step.finishedAt = new Date().toISOString();
}

export function updateDependencies(step: ui.UpdateStep, steps: ui.UpdateStep[]): ui.UpdateStep[] {
  return steps.filter((item) => {
    if (item === step || item.state === "skipped") return false;

    // Keep the coordinating app alive until the other Canopy updates have finished.
    if (step.kind === "app") return true;

    if (step.kind === "gateway") return !!item.nodeId;

    if (step.kind === "computer") return item.kind === "worker" && item.nodeId === step.nodeId;

    return item.kind === "gateway" && item.nodeId === step.nodeId;
  });
}

export const dependencyFailureReason = (dependency: ui.UpdateStep): string =>
  `Update ${dependency.label} successfully before retrying this item.`;

/** Only retry a dependent automatically if the scheduler blocked it on a prerequisite. */
export function retryUpdateSteps(steps: ui.UpdateStep[], selected: ui.UpdateStep[]): ui.UpdateStep[] {
  const dependents = steps.filter((step) => {
    if (step.state !== "blocked" || step.kind !== "worker" || selected.includes(step)) return false;
    const prerequisites = updateDependencies(step, steps);

    return (
      prerequisites.some((item) => selected.includes(item)) &&
      prerequisites.some((item) => step.reason === dependencyFailureReason(item))
    );
  });

  return [...selected, ...dependents];
}

/** Updates that can take down the command transport of another step. */
export function restartsUpdateTarget(update: ui.UpdateStep, step: ui.UpdateStep): boolean {
  if (["gateway", "app"].includes(update.kind)) return true;

  if (update.nodeId !== step.nodeId) return false;

  return (
    update.kind === "computer" || (["worker", "desktop"].includes(update.kind) && update.workerId === step.workerId)
  );
}
