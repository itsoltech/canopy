import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const headers = { "cache-control": "no-store" };

export const GET: RequestHandler = async () =>
  json(encode(ui.DiagnosticsGrantsSchema, await call((api) => api.getDiagnosticsGrants({}))), { headers });

export const POST: RequestHandler = async ({ request }) => {
  const message = await readMessage(request, ui.DiagnosticsGrantRequestSchema);

  return json(encode(ui.DiagnosticsGrantsSchema, await call((api) => api.setDiagnosticsGrant(message))), { headers });
};
