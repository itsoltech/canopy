import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Replaces the given sections; a stale `expectedVersion` is a 409 (reload and re-apply). */
export const PUT: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.UpdateUserSettingsRequestSchema);
  return json(encode(ui.UpdateUserSettingsResponseSchema, await call((api) => api.updateUserSettings(body))));
};
