import { error, json } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Which catalog models a profile shows in pickers (`showAll` = every model). */
export const PUT: RequestHandler = async ({ params, request }) => {
  const body = await readMessage(request, ui.SetModelSelectionRequestSchema);
  if (body.workerId !== params.workerId) error(400, "workerId does not match the URL");
  return json(encode(ui.SetModelSelectionResponseSchema, await call((api) => api.setModelSelection(body))));
};
