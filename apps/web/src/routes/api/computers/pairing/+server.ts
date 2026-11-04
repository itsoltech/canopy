import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  await readMessage(request, ui.CreateComputerPairingRequestSchema);

  return json(encode(ui.ComputerPairingSchema, await call((api) => api.createComputerPairing({}))), {
    headers: { "cache-control": "no-store" },
  });
};
