import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const headers = { "cache-control": "no-store" };

export const GET: RequestHandler = async () =>
  json(encode(ui.NetworkAccessSchema, await call((api) => api.getNetworkAccess({}))), { headers });

export const PUT: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.UpdateNetworkAccessRequestSchema);

  return json(encode(ui.NetworkAccessSchema, await call((api) => api.updateNetworkAccess(body))), { headers });
};
