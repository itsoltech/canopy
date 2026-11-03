import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Project thread defaults (override the user's); a stale `expectedVersion` is a 409. */
export const PUT: RequestHandler = async ({ request, params }) => {
  const body = await readMessage(request, ui.UpdateProjectSettingsRequestSchema);
  const response = await call((api) => api.updateProjectSettings({ ...body, projectId: params.projectId }));
  return json(encode(ui.UpdateProjectSettingsResponseSchema, response));
};
