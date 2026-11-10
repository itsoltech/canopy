import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
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

  return json(encode(ui.DiagnosticsSnapshotSchema, await call((api) => api.getDiagnostics({ windowMinutes }))), {
    headers,
  });
};
