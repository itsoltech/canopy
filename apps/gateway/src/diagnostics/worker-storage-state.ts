import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { sanitizeStorage } from "@canopy/domain/diagnostics";
import type { Diagnostics } from "./service.ts";
import type { LinkDiagnostics } from "./links.ts";

/** Last-known resource gauges are bounded separately from session/sequence replay fences. */
export function workerStorageState(links: Iterable<LinkDiagnostics>) {
  return [...links]
    .filter((link) => link.kind === "worker")
    .slice(0, 16)
    .flatMap((link) => {
      const storage = sanitizeStorage(link.storageSnapshot());

      return storage?.sampledAtMs
        ? [create(ui.DiagnosticsWorkerStorageSchema, { workerId: link.target, storage })]
        : [];
    });
}

export function restoreDiagnosticsState(diagnostics: Diagnostics, state: ui.DiagnosticsState) {
  diagnostics.clients.restore(state.watermarks);
  diagnostics.findings.restore(state.findings);
  diagnostics.peers.restore(state.peerOverviews);

  for (const row of state.workerStorage.slice(0, 16)) {
    const storage = sanitizeStorage(row.storage);

    if (
      storage &&
      ["worker", "desktop"].includes(storage.component) &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row.workerId)
    )
      diagnostics.link(row.workerId, "worker")?.restoreStorage(storage);
  }

  for (const link of diagnostics.links.values())
    link.resetAt = diagnostics.persistence?.baselines.get(`${link.kind}:${link.target}`) ?? 0;

  for (const watermark of state.watermarks) {
    const [kind, target] = watermark.processId.split(":");

    if (target && (kind === "worker" || kind === "computer"))
      diagnostics.link(target, kind)?.restoreWatermark(watermark);
  }
}
