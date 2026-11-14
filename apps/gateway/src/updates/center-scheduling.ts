import type { ui } from "@canopy/contracts";

export const UPDATE_CONCURRENCY = 4;
export const pendingUpdate = (step: ui.UpdateStep): boolean => ["queued", "running"].includes(step.state);

export function updateDependencies(step: ui.UpdateStep, steps: ui.UpdateStep[]): ui.UpdateStep[] {
  return steps.filter((item) => {
    if (item === step || item.state === "skipped") return false;

    if (step.kind === "app") return true;

    if (step.kind === "gateway")
      // Restart the coordinator after independent work. Its own workers must wait for the new gateway.
      return item.kind !== "app" && !(item.nodeId === "" && ["worker", "cli", "desktop"].includes(item.kind));

    if (["desktop", "computer"].includes(step.kind))
      return ["worker", "cli"].includes(item.kind) && item.nodeId === step.nodeId;

    return (
      item.nodeId === step.nodeId &&
      ((item.kind === "gateway" && ["worker", "cli"].includes(step.kind)) ||
        (item.kind === "worker" && step.kind === "cli" && item.workerId === step.workerId))
    );
  });
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

export function updatesConflict(a: ui.UpdateStep, b: ui.UpdateStep, snapshot: ui.UpdatesSnapshot): boolean {
  if (a.nodeId !== b.nodeId || a.workerId !== b.workerId || a.kind !== "cli" || b.kind !== "cli") return false;

  return a.provider === b.provider || (!!resource(a, snapshot) && resource(a, snapshot) === resource(b, snapshot));
}
