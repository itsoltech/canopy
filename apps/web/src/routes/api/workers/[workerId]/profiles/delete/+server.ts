import { error, json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Deletes a profile no thread uses (in use: 409, disable it instead). */
export const POST: RequestHandler = async ({ params, request }) => {
  const body = await readMessage(request, ui.DeleteProviderProfileRequestSchema);
  if (body.workerId !== params.workerId) error(400, "workerId does not match the URL");
  return json(encode(ui.DeleteProviderProfileResponseSchema, await call((api) => api.deleteProviderProfile(body))));
};
