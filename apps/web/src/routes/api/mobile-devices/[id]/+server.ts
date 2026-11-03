import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import type { RequestHandler } from "./$types";

// JSON body is required for the same CSRF boundary as other BFF mutations.
export const DELETE: RequestHandler = async ({ request, params, url }) => {
  await readMessage(request, ui.GetMobileDevicesRequestSchema);
  await call((api) => url.searchParams.get("kind") === "pairing"
    ? api.revokeMobilePairing({ id: params.id }) : api.revokeMobileDevice({ id: params.id }));
  return json({}, { headers: { "cache-control": "no-store" } });
};
