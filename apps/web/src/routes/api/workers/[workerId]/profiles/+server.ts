import { error, json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** The worker's provider profiles (secrets only as "set"). */
export const GET: RequestHandler = async ({ params }) =>
  json(encode(ui.ListProviderProfilesResponseSchema, await call((api) => api.listProviderProfiles({ workerId: params.workerId }))));

/** Creates (empty profileId) or changes a profile; a stale `expectedConfigVersion` is a 409. */
export const POST: RequestHandler = async ({ params, request }) => {
  const body = await readMessage(request, ui.SaveProviderProfileRequestSchema);
  if (body.workerId !== params.workerId) error(400, "workerId does not match the URL");
  return json(encode(ui.SaveProviderProfileResponseSchema, await call((api) => api.saveProviderProfile(body))));
};
