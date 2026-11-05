import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { splitId } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import { requestComputerUpdate } from "../updates/linked.ts";
import { peerOf } from "./routed-home.ts";
import type { UiHandlers } from "./ui-service.ts";

/** A linked computer's binary worker updates at its home (docs/updates.md, "Połączone komputery"). */
export function linkedManageUpdates(core: GatewayCore, local: UiHandlers): UiHandlers["manageUpdates"] {
  return async (request, context) => {
    const { id, node } = splitId(request.workerId);

    if (!node) return local.manageUpdates(request, context);

    if (request.action !== "worker")
      throw new ConnectError("Update this on the computer it runs on", Code.FailedPrecondition);

    if ((await core.updateCenter.status())?.state === "running")
      throw new ConnectError(
        "Update all is running. Wait for it to finish before starting another update.",
        Code.FailedPrecondition,
      );
    await requestComputerUpdate(core, await peerOf(core, node), "worker", id);

    return local.getUpdates(create(ui.UpdatesRequestSchema), context);
  };
}
