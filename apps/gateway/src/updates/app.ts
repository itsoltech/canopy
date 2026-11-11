import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import type { GatewayCore } from "../core/core.ts";
import { mobileIdentity } from "../core/mobile-devices.ts";

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
