import { Code, ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { reachedUpdateVersion } from "@canopy/domain/release/remote-update-state";

function stepCli(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot) {
  const home = step.nodeId ? snapshot.computers.find((item) => item.nodeId === step.nodeId)?.updates : snapshot;

  return home?.cliWorkers
    .find((worker) => worker.id === step.workerId)
    ?.cliTools.find((item) => item.tool?.provider === step.provider)?.tool;
}

export function runningCliAttempt(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot): string {
  if (step.kind !== "cli") return "";
  const install = stepCli(step, snapshot)?.install;

  return install?.state === "running" && install.targetVersion === step.version ? install.installId : "";
}

/** The installed version is authoritative even when an earlier acknowledgement or attempt failed. */
function cliStepCurrent(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot): boolean {
  const tool = stepCli(step, snapshot);

  // Any installer for this CLI may still roll back a version observed during validation.
  if (tool?.install?.state === "running") return false;
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

/** The worker explicitly refused this command. A fresh snapshot can follow the other attempt or launch this step. */
export function requeueBusyCli(step: ui.UpdateStep, error: Error | undefined, waitingSince: string): boolean {
  if (step.kind !== "cli" || !(error instanceof ConnectError) || error.code !== Code.Aborted) return false;

  step.state = "queued";
  step.startedAt = waitingSince || step.startedAt;
  step.requestId = "";

  return true;
}

export function waitForCli(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot, timeoutMs: number): boolean {
  if (step.kind !== "cli") return false;

  if (step.startedAt && Date.now() - Date.parse(step.startedAt) > timeoutMs)
    throw new Error("Timed out waiting for another CLI installation. Check the worker and retry.");

  const install = stepCli(step, snapshot)?.install;

  if (install?.state !== "running" || install.targetVersion === step.version) return false;
  step.startedAt ||= new Date().toISOString();

  return true;
}

/** An uncertain reply must leave time for worker reports; installations are never replayed automatically. */
export function uncertainCliLaunch(step: ui.UpdateStep, error: Error): boolean {
  return (
    step.kind === "cli" &&
    (!(error instanceof ConnectError) ||
      [Code.Canceled, Code.Unknown, Code.DeadlineExceeded, Code.Internal, Code.Unavailable].includes(error.code))
  );
}
