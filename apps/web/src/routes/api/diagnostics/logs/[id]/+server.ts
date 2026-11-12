import { json, error } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const headers = { "cache-control": "no-store" };

function jobId(value: string) {
  if (!/^[a-f0-9-]{36}$/.test(value)) error(400, "Choose a log collection");

  return value;
}

export const GET: RequestHandler = async ({ params }) =>
  json(
    encode(ui.DiagnosticsLogsJobSchema, await call((api) => api.getDiagnosticsLogsJob({ jobId: jobId(params.id) }))),
    { headers },
  );

export const DELETE: RequestHandler = async ({ params, request, url }) => {
  if (
    request.headers.get("origin") !== url.origin ||
    !request.headers.get("content-type")?.startsWith("application/json")
  )
    error(403, "Open Diagnostics to cancel this collection");

  return json(
    encode(ui.DiagnosticsLogsJobSchema, await call((api) => api.cancelDiagnosticsLogs({ jobId: jobId(params.id) }))),
    { headers },
  );
};
