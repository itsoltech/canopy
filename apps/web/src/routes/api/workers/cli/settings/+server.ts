import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = async ({ request }) => {
  const body = await readMessage(request, ui.SetWorkerCliUpdateSettingsRequestSchema);

  return json(encode(ui.WorkerOperationResponseSchema, await call((api) => api.setWorkerCliUpdateSettings(body))));
};
