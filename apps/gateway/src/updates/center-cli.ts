import { Code, ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { reachedUpdateVersion } from "@canopy/domain/release/remote-update-state";

export function stepCli(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot) {
  const home = step.nodeId ? snapshot.computers.find((item) => item.nodeId === step.nodeId)?.updates : snapshot;

  return home?.cliWorkers
    .find((worker) => worker.id === step.workerId)
    ?.cliTools.find((item) => item.tool?.provider === step.provider)?.tool;
}

/** The installed version is authoritative even when an earlier acknowledgement or attempt failed. */
export function cliStepCurrent(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot): boolean {
  const tool = stepCli(step, snapshot);

  // A matching installer may still roll back a version observed during validation.
  if (tool?.install?.state === "running" && tool.install.installId === step.requestId) return false;
  const version = tool?.version;

  return !!version && reachedUpdateVersion(version, step.version);
}

export function cliStepComplete(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot, beforeLaunch: boolean): boolean {
  if (cliStepCurrent(step, snapshot)) return true;
  const install = stepCli(step, snapshot)?.install;

  if (!beforeLaunch && step.requestId && install?.installId === step.requestId && install.state === "failed")
    throw new Error(install.error || "CLI install failed");

  return false;
}

/** An uncertain reply must leave time for worker reports; installations are never replayed automatically. */
export function uncertainCliLaunch(step: ui.UpdateStep, error: Error): boolean {
  return (
    step.kind === "cli" &&
    (!(error instanceof ConnectError) ||
      [Code.Canceled, Code.Unknown, Code.DeadlineExceeded, Code.Internal, Code.Unavailable].includes(error.code))
  );
}
