import { json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

const headers = { "cache-control": "no-store" };
export const GET: RequestHandler = async () => json(encode(ui.GetMobileDevicesResponseSchema,
  await call((api) => api.getMobileDevices({}))), { headers });
export const POST: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.CreateMobilePairingRequestSchema);
  return json(encode(ui.CreateMobilePairingResponseSchema, await call((api) => api.createMobilePairing(body))), { headers });
};
