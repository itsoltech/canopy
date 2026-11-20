import { isHttpError, json } from "@sveltejs/kit";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import { bffStorage, bffStorageWorker } from "@canopy/domain/bff-storage";
import { bffTarget } from "@canopy/domain/bff-target";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => {
  const windowMinutes = Number(url.searchParams.get("range") ?? 15);
  const computerId = url.searchParams.get("computer");
  const headers = { "cache-control": "no-store" };

  if (computerId)
    return json(
      encode(
        ui.ComputerDiagnosticsSchema,
        await call((api) =>
          api.getComputerDiagnostics({
            computerId,
            windowMinutes,
            offset: Number(url.searchParams.get("offset") ?? 0),
            limit: 32,
            sortBy: url.searchParams.get("sort") ?? "method",
            callKind: url.searchParams.get("kind") ?? "",
            methodKeys: url.searchParams.getAll("method"),
          }),
        ),
      ),
      { headers },
    );

  const snapshot = await call((api) => api.getDiagnostics({ windowMinutes })).catch((cause) => {
    // The controller can measure its own files while the paired gateway is unavailable.
    if (bffTarget()?.target.mode !== "remote" || !bffStorage() || !isHttpError(cause) || cause.status < 500)
      throw cause;

    return create(ui.DiagnosticsSnapshotSchema);
  });

  const worker = bffStorageWorker();

  const reported =
    worker &&
    snapshot.computers.some((computer) =>
      computer.links.some(
        (link) =>
          computer.status === "online" &&
          link.kind === "worker" &&
          link.targetId === worker &&
          link.online &&
          link.storage?.component === "desktop" &&
          ["ready", "partial"].includes(link.storage.status) &&
          link.storage.sampleAgeMs <= 5 * 60_000,
      ),
    );

  // Only this desktop can inspect its local files. A local gateway already reports the same app.
  snapshot.desktopStorage = bffTarget()?.target.mode === "remote" && !reported ? bffStorage() : undefined;

  return json(encode(ui.DiagnosticsSnapshotSchema, snapshot), {
    headers,
  });
};
