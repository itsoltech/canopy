import { Code, ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { splitId } from "@canopy/domain/computers";
import type { GatewayCore } from "../core/core.ts";
import { requestComputerUpdate } from "./linked.ts";

/**
 * Update all and its retries. Returns false for other actions; otherwise the snapshot Update all planned from, when
 * there is one, so the answer does not read every computer again.
 */
export async function manageUpdateRun(
  core: GatewayCore,
  request: ui.ManageUpdatesRequest,
): Promise<false | { planned: ui.UpdatesSnapshot | undefined }> {
  // Older clients keep these actions. New clients use distinct names so an older gateway fails closed.
  const action = request.action.replace(/^canopy_/, "");

  if (!["update_all", "retry_step", "retry_failed"].includes(action)) return false;

  if (request.force || request.allowDowngrade || request.workerId || request.nodeId)
    throw new ConnectError("Bulk updates cannot force a restart or select another target.", Code.InvalidArgument);

  if (core.updates.kind === "binary") core.updates.assertControlReady();

  if (action === "update_all") return { planned: await core.updateCenter.begin(request.confirmRestart) };

  if (action === "retry_failed") await core.updateCenter.retryFailed(request.desktopRequestId, request.confirmRestart);
  else await core.updateCenter.retry(request.desktopRequestId, request.updateStepIndex, request.confirmRestart);

  return { planned: undefined };
}

export async function manageRunWorker(core: GatewayCore, request: ui.ManageUpdatesRequest, nodeId = "") {
  if (!nodeId) return core.updates.manage(request);

  return requestComputerUpdate(core, nodeId, "worker", splitId(request.workerId).id);
}
