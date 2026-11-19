import type { ui } from "@canopy/contracts";

export const UPDATE_CONCURRENCY = 4;
export const pendingUpdate = (step: ui.UpdateStep): boolean => ["queued", "running"].includes(step.state);

export function succeedUpdate(step: ui.UpdateStep) {
  step.state = "succeeded";
  step.finishedAt = new Date().toISOString();
}

export function updateDependencies(step: ui.UpdateStep, steps: ui.UpdateStep[]): ui.UpdateStep[] {
  return steps.filter((item) => {
    if (item === step || item.state === "skipped" || item.kind === "cli") return false;

    // Keep the coordinating app alive until the other Canopy updates have finished.
    // The CLI phase can then resume from the durable run after its restart.
    if (step.kind === "app" || step.kind === "cli") return true;

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
    if (step.state !== "blocked" || !["worker", "cli"].includes(step.kind) || selected.includes(step)) return false;
    const prerequisites = updateDependencies(step, steps);

    return (
      prerequisites.some((item) => selected.includes(item)) &&
      prerequisites.some((item) => step.reason === dependencyFailureReason(item))
    );
  });

  return [...selected, ...dependents];
}

function resource(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot): string {
  const home = step.nodeId ? snapshot.computers.find((item) => item.nodeId === step.nodeId)?.updates : snapshot;

  const cli = home?.cliWorkers
    .find((worker) => worker.id === step.workerId)
    ?.cliTools.find((item) => item.tool?.provider === step.provider)?.tool;

  if (!cli) return "";

  if (cli.installResource) return cli.installResource;

  // Older workers do not report resources and only admit one installer, even for native tools.
  return "legacy:worker";
}

/** Updates that can take down the command transport of another step. */
export function restartsUpdateTarget(update: ui.UpdateStep, step: ui.UpdateStep): boolean {
  if (["gateway", "app"].includes(update.kind)) return true;

  if (update.nodeId !== step.nodeId) return false;

  return (
    update.kind === "computer" || (["worker", "desktop"].includes(update.kind) && update.workerId === step.workerId)
  );
}

export function updatesConflict(a: ui.UpdateStep, b: ui.UpdateStep, snapshot: ui.UpdatesSnapshot): boolean {
  // Older persisted runs may already be installing a CLI when its host is due to restart.
  if (a.kind !== "cli") return b.kind === "cli" && restartsUpdateTarget(a, b);

  if (b.kind !== "cli") return restartsUpdateTarget(b, a);

  if (a.nodeId !== b.nodeId || a.workerId !== b.workerId) return false;

  return a.provider === b.provider || (!!resource(a, snapshot) && resource(a, snapshot) === resource(b, snapshot));
}
