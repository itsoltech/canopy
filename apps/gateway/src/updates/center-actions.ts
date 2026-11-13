import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { nodeRef, splitId } from "@canopy/domain/computers";
import type { GatewayCore } from "../core/core.ts";
import { sendWorkerSetting } from "../api/routed-workers.ts";
import { linkedMessage, methodNamed } from "../computers/remote.ts";
import { PEER_UPDATE_INSTALL_TIMEOUT_MS } from "../computers/timing.ts";
import { requestComputerUpdate, refreshComputerUpdates } from "./linked.ts";

export async function manageUpdateRun(core: GatewayCore, request: ui.ManageUpdatesRequest): Promise<boolean> {
  if (!["update_all", "retry_step"].includes(request.action)) return false;

  if (request.force || request.allowDowngrade || request.workerId || request.nodeId)
    throw new ConnectError("Bulk updates cannot force a restart or select another target.", Code.InvalidArgument);

  if (request.action === "update_all") await core.updateCenter.begin(request.confirmRestart);
  else await core.updateCenter.retry(request.desktopRequestId, request.updateStepIndex, request.confirmRestart);

  return true;
}

export async function manageRunWorker(core: GatewayCore, request: ui.ManageUpdatesRequest, nodeId = "") {
  if (!nodeId) return core.updates.manage(request);

  return requestComputerUpdate(core, nodeId, "worker", splitId(request.workerId).id);
}

/** The same authenticated, owner-scoped InstallCli route as an individual linked CLI button. */
export async function installRunCli(core: GatewayCore, request: ui.InstallCliRequest, nodeId = "") {
  if (!nodeId) return core.installCli(request);

  if (!core.computers || !(await core.computers.store.peer(nodeId)))
    throw new ConnectError("That computer is no longer linked", Code.NotFound);

  const response = linkedMessage(
    ui.InstallCliResponseSchema,
    await sendWorkerSetting(
      core,
      methodNamed("InstallCli")!,
      create(ui.InstallCliRequestSchema, request),
      nodeRef(nodeId),
      AbortSignal.timeout(PEER_UPDATE_INSTALL_TIMEOUT_MS),
    ),
  );

  refreshComputerUpdates(core, nodeId);

  return response;
}
