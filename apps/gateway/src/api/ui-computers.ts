import { computerGuard } from "../computers/runtime.ts";
import { type GatewayCore } from "../core/core.ts";
import { computers, moves, shared } from "./ui-computers-context.ts";
import type { UiHandlers } from "./ui-service.ts";

export function computersHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "getComputers"
  | "createComputerPairing"
  | "linkComputer"
  | "manageComputer"
  | "getSharedConfig"
  | "manageSharedConfig"
  | "previewMove"
  | "startMove"
  | "getMoves"
> {
  return {
    getComputers: () => computerGuard(() => computers(core).snapshot()),

    createComputerPairing: () => computerGuard(() => computers(core).createPairing()),

    linkComputer: (r) => computerGuard(() => computers(core).pair(r.address, r.code)),

    manageComputer: (r) => computerGuard(() => computers(core).manage(r)),

    getSharedConfig: () => computerGuard(() => shared(core).snapshot()),

    manageSharedConfig: (r) => computerGuard(() => shared(core).manage(r)),

    previewMove: (r) => computerGuard(() => moves(core).preview(r)),

    startMove: (r) => computerGuard(() => moves(core).start(r)),

    getMoves: (r) => computerGuard(() => moves(core).list(r.batchId)),
  };
}
