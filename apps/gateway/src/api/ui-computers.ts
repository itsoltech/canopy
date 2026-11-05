import { computerGuard } from "../computers/runtime.ts";
import { type GatewayCore } from "../core/core.ts";
import { computers, moves, shared } from "./ui-computers-context.ts";
import type { UiHandlers } from "./ui-service.ts";
import { manageConfigNotice } from "../config-sync/notices.ts";

export function computersHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "getComputers"
  | "createComputerPairing"
  | "linkComputer"
  | "manageComputer"
  | "manageConfigNotice"
  | "getSharedConfig"
  | "manageSharedConfig"
  | "previewMove"
  | "startMove"
  | "getMoves"
> {
  return {
    getComputers: () => computerGuard(() => computers(core).snapshot()),

    createComputerPairing: (r) => computerGuard(() => computers(core).createPairing(r.shareConfig)),

    linkComputer: (r) => computerGuard(() => computers(core).pair(r.address, r.code, r.shareConfig)),

    manageComputer: (r) => computerGuard(() => computers(core).manage(r)),
    manageConfigNotice: (r) =>
      computerGuard(async () => {
        const linked = computers(core);

        if (!linked.config) throw new Error("Configuration sync unavailable");
        await manageConfigNotice(linked.config, r.id, r.action);

        return linked.snapshot();
      }),

    getSharedConfig: () => computerGuard(() => shared(core).snapshot()),

    manageSharedConfig: (r) => computerGuard(() => shared(core).manage(r)),

    previewMove: (r) => computerGuard(() => moves(core).preview(r)),

    startMove: (r) => computerGuard(() => moves(core).start(r)),

    getMoves: (r) => computerGuard(() => moves(core).list(r.batchId)),
  };
}
