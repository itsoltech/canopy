import { computerGuard } from "../computers/runtime.ts";
import { type GatewayCore } from "../core/core.ts";
import { computers, moves } from "./ui-computers-context.ts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { UiHandlers } from "./ui-service.ts";
import { manageConfigNotice } from "../config-sync/notices.ts";
import { listWorkerRecords } from "./worker-records.ts";
import { mobileIdentity } from "../core/mobile-devices.ts";
import { coreState } from "../core/core-context.ts";
import { readRangeDiagnostics } from "../computers/range-diagnostics.ts";

export function computersHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "getComputers"
  | "getThreadSyncDiagnostics"
  | "createComputerPairing"
  | "linkComputer"
  | "manageComputer"
  | "manageConfigNotice"
  | "getSharedConfig"
  | "manageSharedConfig"
  | "previewMove"
  | "startMove"
  | "getMoves"
  | "listWorkerRecords"
> {
  return {
    getThreadSyncDiagnostics: (request) =>
      computerGuard(() =>
        readRangeDiagnostics(core[coreState].options.runtime, core[coreState].options.userId, request),
      ),
    getComputers: () => computerGuard(() => computers(core).snapshot()),

    createComputerPairing: (r) => computerGuard(() => computers(core).createPairing(r.shareConfig)),

    linkComputer: (r) => computerGuard(() => computers(core).pair(r.address, r.code, r.shareConfig)),

    manageComputer: (r, context) =>
      computerGuard(async () => {
        const linked = computers(core);

        if (r.action === "presence") {
          if (context.values.get(mobileIdentity))
            throw new ConnectError("Only this computer can announce its departure", Code.PermissionDenied);

          if (r.name === "updating" || r.name === "restarting")
            await core.departures.announce(
              r.name,
              r.targetVersion || (r.name === "updating" ? core.appControl.snapshot().updaterVersion : ""),
            );
        }

        return linked.manage(r);
      }),
    manageConfigNotice: (r) =>
      computerGuard(async () => {
        const linked = computers(core);

        if (!linked.config) throw new Error("Configuration sync unavailable");
        await manageConfigNotice(linked.config, r.id, r.action);

        return linked.snapshot();
      }),

    getSharedConfig: () =>
      computerGuard(async () => {
        computers(core);
        throw new ConnectError("Update Canopy to manage configuration", Code.Unimplemented);
      }),
    manageSharedConfig: () =>
      computerGuard(async () => {
        computers(core);
        throw new ConnectError("Update Canopy to manage configuration", Code.Unimplemented);
      }),

    previewMove: (r) => computerGuard(() => moves(core).preview(r)),

    startMove: (r) => computerGuard(() => moves(core).start(r)),

    getMoves: (r) => computerGuard(() => moves(core).list(r.batchId)),

    listWorkerRecords: () => computerGuard(() => listWorkerRecords(core)),
  };
}
