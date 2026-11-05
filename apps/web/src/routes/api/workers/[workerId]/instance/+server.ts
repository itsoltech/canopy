import { json } from "@sveltejs/kit";
import { ui } from "@canopy/contracts";
import { call } from "#lib/server/gateway.ts";
import { readMessage } from "#lib/server/body.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, params }) => {
  const body = await readMessage(request, ui.GetInstanceWorkerRequestSchema);
  body.workerId = params.workerId;

  return json(encode(ui.GetInstanceWorkerResponseSchema, await call((api) => api.getInstanceWorker(body))));
};
