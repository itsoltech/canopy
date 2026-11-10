import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { workerLinkCompatible } from "@canopy/domain/release/protocol";
import { managedInstructions } from "@canopy/updater";
import type { WorkerUpdateRow } from "./persistence.ts";
import { updateBusyState, versionAhead } from "./versions.ts";

/** Version and installation policy for a worker's update-center row. */
export function workerUpdateSnapshot(
  w: WorkerUpdateRow,
  version: string,
  bundled: boolean,
  connected: boolean,
): ui.WorkerUpdate {
  return create(ui.WorkerUpdateSchema, {
    workerId: w.id,
    name: w.name,
    bundled: bundled && w.bundled === true,
    version: w.version,
    installKind: w.status.installKind ?? "unknown",
    compatibility: workerLinkCompatible(w.status.minWorkerLinkProtocol ?? 0, w.status.workerLinkProtocol ?? 0)
      ? "compatible"
      : "update_required",
    ...(versionAhead(w.version, version) && !updateBusyState(w.status.state)
      ? {
          // A newer desktop's worker never downgrades to match this gateway.
          state: "ahead",
          reason: `Newer than this gateway. Update the gateway to ${w.version} or later.`,
        }
      : {
          state:
            w.status.state === "succeeded" && w.version !== version
              ? "idle"
              : (w.status.state ??
                (w.status.installKind && w.status.installKind !== "binary" ? "managed_externally" : "idle")),
          reason:
            w.status.reason ??
            (w.status.installKind && w.status.installKind !== "binary"
              ? managedInstructions(w.status.installKind)
              : !w.status.installKind
                ? "This worker has not reported to the update channel. Older installations need one manual upgrade."
                : ""),
        }),
    connected,
  });
}
