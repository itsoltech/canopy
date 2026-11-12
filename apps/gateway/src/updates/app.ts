import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { GatewayCore } from "../core/core.ts";
import { mobileIdentity } from "../core/mobile-devices.ts";
import { requestComputerUpdate } from "./linked.ts";

/** Dismiss the same app request as the stopped step, without acknowledging any later failure. */
async function dismissRunApp(core: GatewayCore, step: ui.UpdateStep) {
  if (!step.requestId || !["computer", "desktop"].includes(step.kind)) return;
  const snapshot = await core.updateCenter.options.snapshot();

  const app =
    step.kind === "computer"
      ? snapshot.computers.find((computer) => computer.nodeId === step.nodeId)?.updates?.app
      : snapshot.workers.find((worker) => worker.workerId === step.workerId)?.desktop;

  if (app?.requestId !== step.requestId || app.phase !== "failed") return;

  if (step.kind === "computer") await requestComputerUpdate(core, step.nodeId, "dismiss", step.requestId);
  else
    await core.desktopControl.manage(
      create(ui.ManageUpdatesRequestSchema, {
        action: "desktop_dismiss",
        workerId: step.workerId,
        desktopRequestId: step.requestId,
      }),
    );
}

/** Acknowledgements use the same owner and target boundaries as requests; they never install anything. */
export async function dismissUpdateFailure(core: GatewayCore, request: ui.ManageUpdatesRequest): Promise<boolean> {
  if (request.action === "dismiss_run")
    await core.updateCenter.dismiss(request.desktopRequestId, (step) => dismissRunApp(core, step));
  else if (request.action === "app_dismiss") {
    if (core.role !== "desktop") throw new ConnectError("This gateway has no desktop app.", Code.FailedPrecondition);
    await core.appControl.dismiss(request.desktopRequestId);
    const state = core.appControl.snapshot();
    await core.departures.recover("dismissed", "", state.targetVersion);
  } else if (request.action === "computer_dismiss")
    await requestComputerUpdate(core, request.nodeId, "dismiss", request.desktopRequestId);
  else if (request.action === "desktop_dismiss") await core.desktopControl.manage(request);
  else return false;

  return true;
}

/** Authenticated owner UI only; the desktop keeps its updater, journal and idle barrier. */
export async function requestOwnAppUpdate(
  core: GatewayCore,
  request: ui.ManageUpdatesRequest,
  context: HandlerContext,
) {
  if (core.role !== "desktop")
    throw new ConnectError("This gateway has no desktop app to update.", Code.FailedPrecondition);

  if (!request.confirmRestart)
    throw new ConnectError("Confirm the computer restart before updating its app.", Code.FailedPrecondition);

  if (request.force || request.allowDowngrade || request.nodeId || request.workerId)
    throw new ConnectError("App updates cannot force a restart or select another target.", Code.InvalidArgument);
  await core.appControl.request({
    nodeId: "",
    name: "",
    deviceId: context.values.get(mobileIdentity)?.deviceId || "",
  });
}
